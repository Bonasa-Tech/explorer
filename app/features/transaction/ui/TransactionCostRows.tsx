import { InfoTooltip } from '@components/common/InfoTooltip';
import { SolBalance } from '@components/common/SolBalance';
import { cn } from '@components/shared/utils';
import {
    BASE_INCLUSION_FEE_LAMPORTS,
    type CostUnitBreakdown,
    getResourceFee,
    type LoadedAccountsDataSize,
    RESOURCE_FEE_RATES,
    type TransactionCostEstimate,
    type TransactionCostInputs,
    useTransactionCost,
} from '@entities/transaction-cost';
import type { VersionedMessage } from '@solana/web3.js';
import React from 'react';

import { Label, Row, Value } from './summary-rows';

/**
 * The rate stage shown as the headline figure: the terminal one, once the ramp is fully activated.
 * The earlier stages are listed in the breakdown.
 */
const HEADLINE_RATE = RESOURCE_FEE_RATES[RESOURCE_FEE_RATES.length - 1];

const numberFormat = new Intl.NumberFormat('en-US');

function formatBytes(bytes: number): string {
    if (bytes >= 1024 * 1024) return `${(bytes / (1024 * 1024)).toFixed(bytes % (1024 * 1024) === 0 ? 0 : 2)} MiB`;
    if (bytes >= 1024) return `${(bytes / 1024).toFixed(bytes % 1024 === 0 ? 0 : 2)} KiB`;
    return `${numberFormat.format(bytes)} B`;
}

/** A breakdown line: an indented label, the arithmetic behind it, and the resulting cost units. */
function DetailRow({
    label,
    formula,
    value,
    className,
}: {
    label: string;
    formula?: string;
    value: React.ReactNode;
    className?: string;
}) {
    return (
        <Row className={cn('min-h-0 py-1', className)}>
            <Label className="pl-3 text-xs text-outer-space-400">{label}</Label>
            <div className="flex flex-wrap items-baseline gap-x-2 font-mono text-xs text-outer-space-200">
                <span>{value}</span>
                {formula && <span className="text-outer-space-400">({formula})</span>}
            </div>
        </Row>
    );
}

/** Say what the account lookup covered, so the measured figure can be judged. */
function measuredDescription(measured: LoadedAccountsDataSize | undefined): string {
    if (!measured) return 'measured';
    const parts = [`${measured.resolvedCount} of ${measured.requestedCount} accounts on chain`];
    if (measured.programDataBytes > 0) parts.push(`${formatBytes(measured.programDataBytes)} of program bytecode`);
    return parts.join(', ');
}

/** Spell out the signature term, which folds transaction and precompile signatures together. */
function signatureFormula(inputs: TransactionCostInputs): string {
    const terms = [`${inputs.numTransactionSignatures} × 720`];
    const { ed25519, secp256k1, secp256r1 } = inputs.precompileSignatures;
    if (secp256k1) terms.push(`${secp256k1} × 6,690 secp256k1`);
    if (ed25519) terms.push(`${ed25519} × 2,400 ed25519`);
    if (secp256r1) terms.push(`${secp256r1} × 4,800 secp256r1`);
    return terms.join(' + ');
}

function CostUnitRows({ breakdown, inputs }: { breakdown: CostUnitBreakdown; inputs: TransactionCostInputs }) {
    return (
        <>
            <DetailRow
                label="Signatures"
                formula={signatureFormula(inputs)}
                value={numberFormat.format(breakdown.signatureCost)}
            />
            <DetailRow
                label="Write locks"
                formula={`${inputs.numWriteLocks} × 300`}
                value={numberFormat.format(breakdown.writeLockCost)}
            />
            <DetailRow
                label="Instruction data"
                formula={`${numberFormat.format(inputs.instructionDataBytes)} B ÷ 4`}
                value={numberFormat.format(breakdown.instructionDataCost)}
            />
            <DetailRow
                label="Compute unit limit"
                formula="requested, not consumed"
                value={numberFormat.format(breakdown.programsExecutionCost)}
            />
        </>
    );
}

function EstimateSummary({
    title,
    description,
    estimate,
    priorityFeeLamports,
    highlight,
}: {
    title: string;
    description: string;
    estimate: TransactionCostEstimate;
    priorityFeeLamports: number;
    highlight?: boolean;
}) {
    const resourceFee = getResourceFee(estimate.breakdown.total, HEADLINE_RATE);
    const totalFee = BASE_INCLUSION_FEE_LAMPORTS + priorityFeeLamports + resourceFee;

    return (
        <>
            <DetailRow
                label={title}
                formula={description}
                className={cn('pt-2', highlight && 'text-white')}
                value={
                    <span className={cn(highlight && 'text-white')}>
                        {numberFormat.format(estimate.breakdown.total)} CU
                    </span>
                }
            />
            <DetailRow
                label="Loaded accounts data"
                formula={`${formatBytes(estimate.loadedAccountsDataSizeBytes)} ÷ 32 KiB × 8`}
                value={numberFormat.format(estimate.breakdown.loadedAccountsDataSizeCost)}
            />
            <DetailRow
                label={`Resource fee @ ${HEADLINE_RATE.label}`}
                formula="burned in full"
                value={<SolBalance lamports={resourceFee} />}
            />
            <DetailRow
                label="Total fee"
                formula={`2,500 inclusion + ${numberFormat.format(priorityFeeLamports)} priority + ${numberFormat.format(
                    resourceFee,
                )} resource`}
                value={
                    <span className={cn(highlight && 'text-white')}>
                        <SolBalance lamports={totalFee} />
                    </span>
                }
            />
        </>
    );
}

/**
 * The transaction's fee under SGP-0003, priced two ways.
 *
 * A transaction that never declares a loaded-accounts data size limit is billed for the full 64 MiB
 * default — 16,384 CU, which dwarfs most transactions' other costs. Showing both that figure and
 * the one derived from the accounts the transaction really loads makes the gap visible, since
 * closing it is the developer behaviour the proposal is trying to buy.
 */
export function TransactionCostRows({
    message,
    accountKeys,
    requestedComputeUnits,
    feeLamports,
    url,
}: {
    message: VersionedMessage | undefined;
    accountKeys: string[] | undefined;
    requestedComputeUnits: number | undefined;
    feeLamports: number | undefined;
    url: string;
}) {
    const cost = useTransactionCost({ accountKeys, feeLamports, message, requestedComputeUnits, url });

    // eslint-disable-next-line unicorn/no-null -- React's "render nothing" sentinel
    if (!cost) return null;

    const headlineResourceFee = getResourceFee(cost.requested.breakdown.total, HEADLINE_RATE);
    const headlineTotal = BASE_INCLUSION_FEE_LAMPORTS + cost.priorityFeeLamports + headlineResourceFee;

    return (
        <>
            <Row divider>
                <Label className="overflow-visible">
                    <InfoTooltip text="What this transaction would pay under SGP-0003: a fixed 2,500 lamport inclusion fee to the leader, plus a resource fee derived from its cost units that is burned in full. Shown at the terminal 1/2 lamports-per-cost-unit rate the ramp ends at. Cost units here are priced on what the transaction requested — its compute unit limit and loaded-accounts data size — not on what it consumed, which is what the Transaction cost row below reports.">
                        Fee (SGP-0003)
                    </InfoTooltip>
                </Label>
                <Value>
                    <SolBalance lamports={headlineTotal} />
                    {feeLamports !== undefined && (
                        <span className="ml-2 text-outer-space-400">
                            {headlineTotal >= feeLamports ? '+' : '−'}
                            {numberFormat.format(Math.abs(headlineTotal - feeLamports))} lamports vs today
                        </span>
                    )}
                </Value>
            </Row>

            <Row className="min-h-0 pb-0 pt-2">
                <Label className="text-xs uppercase tracking-wide text-outer-space-400">Cost units</Label>
                <div />
            </Row>
            <CostUnitRows breakdown={cost.requested.breakdown} inputs={cost.inputs} />

            <EstimateSummary
                title={cost.usesDefaultDataSizeLimit ? 'As billed (64 MiB default)' : 'As billed (declared limit)'}
                description={
                    cost.usesDefaultDataSizeLimit
                        ? 'no SetLoadedAccountsDataSizeLimit instruction'
                        : 'SetLoadedAccountsDataSizeLimit'
                }
                estimate={cost.requested}
                priorityFeeLamports={cost.priorityFeeLamports}
                highlight
            />

            {cost.loading && (
                <DetailRow label="With actual data size" formula="fetching account sizes…" value="—" className="pt-2" />
            )}
            {cost.error && (
                <DetailRow
                    label="With actual data size"
                    formula="could not fetch account sizes"
                    value="—"
                    className="pt-2"
                />
            )}
            {cost.actual && (
                <EstimateSummary
                    title="With actual data size"
                    description={measuredDescription(cost.measured)}
                    estimate={cost.actual}
                    priorityFeeLamports={cost.priorityFeeLamports}
                />
            )}

            <Row className="min-h-0 pb-2 pt-1" divider>
                <Label className="pl-3 text-xs text-outer-space-400">Resource fee by rate stage</Label>
                <div className="flex flex-wrap gap-x-4 font-mono text-xs text-outer-space-200">
                    {RESOURCE_FEE_RATES.map(rate => (
                        <span key={rate.featureGate}>
                            {rate.label}:{' '}
                            {numberFormat.format(getResourceFee((cost.actual ?? cost.requested).breakdown.total, rate))}{' '}
                            lamports
                        </span>
                    ))}
                </div>
            </Row>
        </>
    );
}
