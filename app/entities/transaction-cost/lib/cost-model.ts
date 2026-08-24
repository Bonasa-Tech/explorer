/**
 * Cost-unit accounting and the SGP-0003 resource fee.
 *
 * SGP-0003 (technical spec: SIMD-0553) splits today's flat 5,000 lamports-per-signature base fee
 * into two parts: a fixed 2,500 lamport *inclusion* fee that goes entirely to the leader, and a
 * *resource* fee derived from the transaction's requested cost units that is burned in full.
 *
 *     resource_fee = ceil_div(requested_cost_units * rate_numerator, rate_denominator)
 *     total_fee    = base_inclusion_fee + priority_fee + resource_fee
 *
 * The cost units are the same ones the block-cost scheduler already charges, so the component
 * constants below are Agave's, not new to the proposal:
 *   - signature / write-lock / instruction-data costs: `cost-model/src/block_cost_limits.rs`
 *   - loaded-accounts-data-size page math:            `program-runtime/src/execution_budget.rs`
 *
 * Two components are billed on what the transaction *requests*, not what it consumes: the compute
 * unit limit and the loaded-accounts data size limit. That second one is why this module reports
 * two totals — see `LoadedAccountsDataSizeBasis`.
 */

/** Compute units charged per transaction signature. */
export const SIGNATURE_COST = 720;
/** Compute units charged per secp256k1 precompile signature. */
export const SECP256K1_VERIFY_COST = 6_690;
/** Compute units charged per ed25519 precompile signature. */
export const ED25519_VERIFY_STRICT_COST = 2_400;
/** Compute units charged per secp256r1 precompile signature. */
export const SECP256R1_VERIFY_COST = 4_800;
/** Compute units charged per write lock. */
export const WRITE_LOCK_UNITS = 300;
/** Instruction data bytes per compute unit — the cost is `bytes / 4`, floored. */
export const INSTRUCTION_DATA_BYTES_COST = 4;

/** Loaded account data is billed in 32 KiB pages. */
export const ACCOUNT_DATA_COST_PAGE_SIZE = 32 * 1024;
/** Compute units charged per 32 KiB page of loaded account data. */
export const DEFAULT_HEAP_COST = 8;
/**
 * The loaded-accounts data size a transaction gets when it does not request one, which is also the
 * ceiling on what it may request. 64 MiB — 2,048 pages — costs 16,384 CU on its own.
 */
export const MAX_LOADED_ACCOUNTS_DATA_SIZE_BYTES = 64 * 1024 * 1024;

/** SGP-0003: the fixed per-transaction fee paid to the leader. */
export const BASE_INCLUSION_FEE_LAMPORTS = 2_500;
/** Today's base fee per signature, half burned and half to the leader. */
export const LAMPORTS_PER_SIGNATURE = 5_000;

export type ResourceFeeRate = {
    /** Human-readable rate, e.g. `1/10`. */
    readonly label: string;
    readonly numerator: number;
    readonly denominator: number;
    /** The feature gate that activates this rate. */
    readonly featureGate: string;
};

/**
 * The three feature-gated stages the resource fee rate ramps through, in activation order. When
 * several gates are live the highest rate wins, so the last active entry is the effective one.
 */
export const RESOURCE_FEE_RATES: readonly ResourceFeeRate[] = [
    { denominator: 10, featureGate: 'resource_fee_burn_1_10', label: '1/10', numerator: 1 },
    { denominator: 4, featureGate: 'resource_fee_burn_1_4', label: '1/4', numerator: 1 },
    { denominator: 2, featureGate: 'resource_fee_burn_1_2', label: '1/2', numerator: 1 },
];

/** Integer ceiling division, matching the spec's integer-only arithmetic. */
export function ceilDiv(numerator: number, denominator: number): number {
    return Math.ceil(numerator / denominator);
}

/** Number of 32 KiB pages needed to hold `bytes`. */
export function pagesForBytes(bytes: number): number {
    return ceilDiv(bytes, ACCOUNT_DATA_COST_PAGE_SIZE);
}

/** Compute units charged for loading `bytes` of account data. */
export function loadedAccountsDataSizeCost(bytes: number): number {
    return pagesForBytes(bytes) * DEFAULT_HEAP_COST;
}

/** Precompile signature counts, keyed by the verifier each one runs on. */
export type PrecompileSignatureCounts = {
    secp256k1: number;
    ed25519: number;
    secp256r1: number;
};

/** Everything needed to price a transaction, all of it derivable from the transaction itself. */
export type CostUnitInputs = {
    /** `numRequiredSignatures` from the message header. */
    numTransactionSignatures: number;
    precompileSignatures: PrecompileSignatureCounts;
    /** Writable accounts, including those resolved through address lookup tables. */
    numWriteLocks: number;
    /** Total bytes of instruction data across the transaction's top-level instructions. */
    instructionDataBytes: number;
    /** The *requested* compute unit limit, not the amount consumed. */
    requestedComputeUnits: number;
    /** The *requested* loaded-accounts data size, in bytes. */
    loadedAccountsDataSizeBytes: number;
};

/** The five components of `requested_cost_units`, plus their sum. */
export type CostUnitBreakdown = {
    signatureCost: number;
    writeLockCost: number;
    instructionDataCost: number;
    programsExecutionCost: number;
    loadedAccountsDataSizeCost: number;
    total: number;
};

export function getSignatureCost(
    numTransactionSignatures: number,
    precompileSignatures: PrecompileSignatureCounts,
): number {
    return (
        numTransactionSignatures * SIGNATURE_COST +
        precompileSignatures.secp256k1 * SECP256K1_VERIFY_COST +
        precompileSignatures.ed25519 * ED25519_VERIFY_STRICT_COST +
        precompileSignatures.secp256r1 * SECP256R1_VERIFY_COST
    );
}

/** Sum the five cost-unit components for a transaction. */
export function getCostUnitBreakdown(inputs: CostUnitInputs): CostUnitBreakdown {
    const signatureCost = getSignatureCost(inputs.numTransactionSignatures, inputs.precompileSignatures);
    const writeLockCost = inputs.numWriteLocks * WRITE_LOCK_UNITS;
    // u16 division in Agave, so the remainder is dropped rather than rounded up.
    const instructionDataCost = Math.floor(inputs.instructionDataBytes / INSTRUCTION_DATA_BYTES_COST);
    const programsExecutionCost = inputs.requestedComputeUnits;
    const dataSizeCost = loadedAccountsDataSizeCost(inputs.loadedAccountsDataSizeBytes);

    return {
        instructionDataCost,
        loadedAccountsDataSizeCost: dataSizeCost,
        programsExecutionCost,
        signatureCost,
        total: signatureCost + writeLockCost + instructionDataCost + programsExecutionCost + dataSizeCost,
        writeLockCost,
    };
}

/** The burned portion of the fee: `ceil_div(cost_units * numerator, denominator)`. */
export function getResourceFee(costUnits: number, rate: ResourceFeeRate): number {
    return ceilDiv(costUnits * rate.numerator, rate.denominator);
}

/** What a transaction pays in total under SGP-0003 at a given rate stage. */
export function getTotalFee(costUnits: number, priorityFeeLamports: number, rate: ResourceFeeRate): number {
    return BASE_INCLUSION_FEE_LAMPORTS + priorityFeeLamports + getResourceFee(costUnits, rate);
}
