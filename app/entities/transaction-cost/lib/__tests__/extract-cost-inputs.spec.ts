import {
    ComputeBudgetProgram,
    Keypair,
    PublicKey,
    SystemProgram,
    TransactionMessage,
    VersionedTransaction,
} from '@solana/web3.js';
import { describe, expect, it } from 'vitest';

import { MAX_LOADED_ACCOUNTS_DATA_SIZE_BYTES } from '../cost-model';
import { extractMessageCostInputs, getRequestedLoadedAccountsDataSize } from '../extract-cost-inputs';

const BLOCKHASH = '11111111111111111111111111111111';
const ED25519_PROGRAM_ID = new PublicKey('Ed25519SigVerify111111111111111111111111111');
const SECP256K1_PROGRAM_ID = new PublicKey('KeccakSecp256k11111111111111111111111111111');

type Instructions = ConstructorParameters<typeof TransactionMessage>[0]['instructions'];

/** web3.js has no builder for this one: discriminator 4, then the byte limit as a u32 LE. */
function setLoadedAccountsDataSizeLimit(bytes: number) {
    const data = Buffer.alloc(5);
    data.writeUInt8(4, 0);
    data.writeUInt32LE(bytes, 1);
    return { data, keys: [], programId: ComputeBudgetProgram.programId };
}

function compile(payer: PublicKey, instructions: Instructions) {
    return new TransactionMessage({
        instructions,
        payerKey: payer,
        recentBlockhash: BLOCKHASH,
    }).compileToV0Message();
}

describe('extractMessageCostInputs', () => {
    const payer = Keypair.generate().publicKey;
    const recipient = Keypair.generate().publicKey;

    it('should read the signature count and instruction data length off the message', () => {
        const message = compile(payer, [
            SystemProgram.transfer({ fromPubkey: payer, lamports: 1, toPubkey: recipient }),
        ]);

        const inputs = extractMessageCostInputs(message);

        expect(inputs.numTransactionSignatures).toBe(1);
        // A System transfer encodes a 4-byte discriminant and an 8-byte amount.
        expect(inputs.instructionDataBytes).toBe(12);
        expect(inputs.precompileSignatures).toEqual({ ed25519: 0, secp256k1: 0, secp256r1: 0 });
        expect(inputs.requestedLoadedAccountsDataSize).toBeUndefined();
    });

    it('should pick up a requested loaded-accounts data size limit', () => {
        const message = compile(payer, [
            setLoadedAccountsDataSizeLimit(128 * 1024),
            SystemProgram.transfer({ fromPubkey: payer, lamports: 1, toPubkey: recipient }),
        ]);

        expect(extractMessageCostInputs(message).requestedLoadedAccountsDataSize).toBe(128 * 1024);
    });

    it('should ignore a compute unit limit instruction when looking for the data size limit', () => {
        const message = compile(payer, [
            ComputeBudgetProgram.setComputeUnitLimit({ units: 100_000 }),
            SystemProgram.transfer({ fromPubkey: payer, lamports: 1, toPubkey: recipient }),
        ]);

        expect(extractMessageCostInputs(message).requestedLoadedAccountsDataSize).toBeUndefined();
    });

    it('should count precompile signatures from the first byte of their instruction data', () => {
        const message = compile(payer, [
            { data: Buffer.from([3, 0, 0]), keys: [], programId: ED25519_PROGRAM_ID },
            { data: Buffer.from([2, 0, 0]), keys: [], programId: SECP256K1_PROGRAM_ID },
        ]);

        const inputs = extractMessageCostInputs(message);

        expect(inputs.precompileSignatures).toEqual({ ed25519: 3, secp256k1: 2, secp256r1: 0 });
    });

    it('should work on a legacy message too', () => {
        const legacy = new TransactionMessage({
            instructions: [SystemProgram.transfer({ fromPubkey: payer, lamports: 1, toPubkey: recipient })],
            payerKey: payer,
            recentBlockhash: BLOCKHASH,
        }).compileToLegacyMessage();

        expect(extractMessageCostInputs(legacy).instructionDataBytes).toBe(12);
    });

    it('should survive a round trip through the wire format', () => {
        const message = compile(payer, [
            SystemProgram.transfer({ fromPubkey: payer, lamports: 1, toPubkey: recipient }),
        ]);
        const wire = new VersionedTransaction(message).serialize();
        const decoded = VersionedTransaction.deserialize(wire).message;

        expect(extractMessageCostInputs(decoded).instructionDataBytes).toBe(12);
    });
});

describe('getRequestedLoadedAccountsDataSize', () => {
    it('should fall back to the 64 MiB default when nothing was requested', () => {
        expect(getRequestedLoadedAccountsDataSize(undefined)).toBe(MAX_LOADED_ACCOUNTS_DATA_SIZE_BYTES);
    });

    it('should honour a smaller request', () => {
        expect(getRequestedLoadedAccountsDataSize(1024)).toBe(1024);
    });

    it('should cap a request above the ceiling', () => {
        expect(getRequestedLoadedAccountsDataSize(MAX_LOADED_ACCOUNTS_DATA_SIZE_BYTES * 2)).toBe(
            MAX_LOADED_ACCOUNTS_DATA_SIZE_BYTES,
        );
    });
});
