import { address } from '@solana/kit';
import { ComputeBudgetProgram, type PublicKey, type VersionedMessage } from '@solana/web3.js';
import {
    ComputeBudgetInstruction,
    identifyComputeBudgetInstruction,
    parseSetLoadedAccountsDataSizeLimitInstruction,
} from '@solana-program/compute-budget';

import { MAX_LOADED_ACCOUNTS_DATA_SIZE_BYTES, type PrecompileSignatureCounts } from './cost-model';

/**
 * The precompiles whose signature counts are billed separately from transaction signatures. Each
 * one stores the number of signatures it verifies in the first byte of its instruction data.
 */
const PRECOMPILE_PROGRAM_IDS: Readonly<Record<string, keyof PrecompileSignatureCounts>> = {
    Ed25519SigVerify111111111111111111111111111: 'ed25519',
    KeccakSecp256k11111111111111111111111111111: 'secp256k1',
    Secp256r1SigVerify1111111111111111111111111: 'secp256r1',
};

/** The parts of the cost inputs that come from the transaction's own bytes. */
export type MessageCostInputs = {
    numTransactionSignatures: number;
    precompileSignatures: PrecompileSignatureCounts;
    instructionDataBytes: number;
    /**
     * The loaded-accounts data size the transaction asked for via `SetLoadedAccountsDataSizeLimit`,
     * or `undefined` when it did not ask — in which case it gets the 64 MiB default.
     */
    requestedLoadedAccountsDataSize: number | undefined;
};

function readComputeBudgetDataSizeLimit(programId: PublicKey, data: Uint8Array): number | undefined {
    if (!programId.equals(ComputeBudgetProgram.programId)) return undefined;

    try {
        const instruction = {
            accounts: [],
            data,
            programAddress: address(programId.toBase58()),
        };
        if (identifyComputeBudgetInstruction(instruction) !== ComputeBudgetInstruction.SetLoadedAccountsDataSizeLimit) {
            return undefined;
        }
        return parseSetLoadedAccountsDataSizeLimitInstruction(instruction).data.accountDataSizeLimit;
    } catch {
        // Not a well-formed compute budget instruction; leave the transaction on the default.
        return undefined;
    }
}

/**
 * Derive the transaction-intrinsic cost inputs from a compiled message.
 *
 * This reads the compiled message rather than the jsonParsed transaction because `jsonParsed`
 * replaces the raw data of every instruction it recognises with a decoded object, and the
 * instruction-data cost is charged on those raw bytes.
 */
export function extractMessageCostInputs(message: VersionedMessage): MessageCostInputs {
    const precompileSignatures: PrecompileSignatureCounts = { ed25519: 0, secp256k1: 0, secp256r1: 0 };
    let instructionDataBytes = 0;
    let requestedLoadedAccountsDataSize: number | undefined;

    for (const instruction of message.compiledInstructions) {
        const programId = message.staticAccountKeys[instruction.programIdIndex];
        instructionDataBytes += instruction.data.length;
        if (!programId) continue;

        const precompile = PRECOMPILE_PROGRAM_IDS[programId.toBase58()];
        if (precompile) {
            // Byte 0 is the signature count; an empty payload verifies nothing.
            precompileSignatures[precompile] += instruction.data[0] ?? 0;
            continue;
        }

        // The runtime honours the first limit instruction and rejects duplicates, so stop at one.
        if (requestedLoadedAccountsDataSize === undefined) {
            requestedLoadedAccountsDataSize = readComputeBudgetDataSizeLimit(programId, instruction.data);
        }
    }

    return {
        instructionDataBytes,
        numTransactionSignatures: message.header.numRequiredSignatures,
        precompileSignatures,
        requestedLoadedAccountsDataSize,
    };
}

/**
 * The loaded-accounts data size a transaction is billed for today: whatever it requested, capped at
 * the 64 MiB ceiling, or that same ceiling when it requested nothing.
 */
export function getRequestedLoadedAccountsDataSize(requested: number | undefined): number {
    if (requested === undefined) return MAX_LOADED_ACCOUNTS_DATA_SIZE_BYTES;
    return Math.min(requested, MAX_LOADED_ACCOUNTS_DATA_SIZE_BYTES);
}
