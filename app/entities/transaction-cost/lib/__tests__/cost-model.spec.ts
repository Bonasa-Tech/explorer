import { describe, expect, it } from 'vitest';

import {
    ceilDiv,
    getCostUnitBreakdown,
    getResourceFee,
    getSignatureCost,
    getTotalFee,
    loadedAccountsDataSizeCost,
    MAX_LOADED_ACCOUNTS_DATA_SIZE_BYTES,
    pagesForBytes,
    RESOURCE_FEE_RATES,
} from '../cost-model';

const NO_PRECOMPILES = { ed25519: 0, secp256k1: 0, secp256r1: 0 };

describe('loadedAccountsDataSizeCost', () => {
    it('should charge nothing for no data', () => {
        expect(loadedAccountsDataSizeCost(0)).toBe(0);
    });

    it('should round partial pages up', () => {
        expect(pagesForBytes(1)).toBe(1);
        expect(loadedAccountsDataSizeCost(1)).toBe(8);
        expect(loadedAccountsDataSizeCost(32 * 1024)).toBe(8);
        expect(loadedAccountsDataSizeCost(32 * 1024 + 1)).toBe(16);
    });

    it('should charge 16,384 CU for the 64 MiB default', () => {
        // 64 MiB / 32 KiB = 2,048 pages, at 8 CU each.
        expect(pagesForBytes(MAX_LOADED_ACCOUNTS_DATA_SIZE_BYTES)).toBe(2048);
        expect(loadedAccountsDataSizeCost(MAX_LOADED_ACCOUNTS_DATA_SIZE_BYTES)).toBe(16_384);
    });
});

describe('getSignatureCost', () => {
    it('should charge 720 CU per transaction signature', () => {
        expect(getSignatureCost(1, NO_PRECOMPILES)).toBe(720);
        expect(getSignatureCost(3, NO_PRECOMPILES)).toBe(2_160);
    });

    it('should charge each precompile at its own verifier rate', () => {
        expect(getSignatureCost(1, { ...NO_PRECOMPILES, secp256k1: 2 })).toBe(720 + 2 * 6_690);
        expect(getSignatureCost(1, { ...NO_PRECOMPILES, ed25519: 2 })).toBe(720 + 2 * 2_400);
        expect(getSignatureCost(1, { ...NO_PRECOMPILES, secp256r1: 2 })).toBe(720 + 2 * 4_800);
    });
});

describe('getCostUnitBreakdown', () => {
    const simpleTransfer = {
        instructionDataBytes: 12,
        loadedAccountsDataSizeBytes: MAX_LOADED_ACCOUNTS_DATA_SIZE_BYTES,
        numTransactionSignatures: 1,
        numWriteLocks: 2,
        precompileSignatures: NO_PRECOMPILES,
        requestedComputeUnits: 3_000,
    };

    it('should sum the five components', () => {
        const breakdown = getCostUnitBreakdown(simpleTransfer);

        expect(breakdown.signatureCost).toBe(720);
        expect(breakdown.writeLockCost).toBe(600);
        expect(breakdown.instructionDataCost).toBe(3);
        expect(breakdown.programsExecutionCost).toBe(3_000);
        expect(breakdown.loadedAccountsDataSizeCost).toBe(16_384);
        expect(breakdown.total).toBe(720 + 600 + 3 + 3_000 + 16_384);
    });

    it('should floor the instruction data cost rather than rounding it up', () => {
        // Agave divides a u16 byte count by 4, so the remainder is dropped.
        expect(getCostUnitBreakdown({ ...simpleTransfer, instructionDataBytes: 15 }).instructionDataCost).toBe(3);
        expect(getCostUnitBreakdown({ ...simpleTransfer, instructionDataBytes: 16 }).instructionDataCost).toBe(4);
    });

    it('should drop the loaded-accounts term by three orders of magnitude when the real size is used', () => {
        const declared = getCostUnitBreakdown({ ...simpleTransfer, loadedAccountsDataSizeBytes: 200 });

        expect(declared.loadedAccountsDataSizeCost).toBe(8);
        expect(declared.total).toBe(720 + 600 + 3 + 3_000 + 8);
    });
});

describe('getResourceFee', () => {
    const [oneTenth, oneQuarter, oneHalf] = RESOURCE_FEE_RATES;

    it('should ramp through the three feature-gated rates', () => {
        expect(getResourceFee(20_000, oneTenth)).toBe(2_000);
        expect(getResourceFee(20_000, oneQuarter)).toBe(5_000);
        expect(getResourceFee(20_000, oneHalf)).toBe(10_000);
    });

    it('should round up, so any cost at all costs at least one lamport', () => {
        expect(ceilDiv(1, 10)).toBe(1);
        expect(getResourceFee(1, oneTenth)).toBe(1);
        expect(getResourceFee(11, oneTenth)).toBe(2);
    });
});

describe('getTotalFee', () => {
    it('should add the inclusion fee and the priority fee to the burned resource fee', () => {
        // 20,707 CU at 1/10 burns 2,071 lamports, on top of 2,500 to the leader.
        expect(getTotalFee(20_707, 0, RESOURCE_FEE_RATES[0])).toBe(2_500 + 2_071);
        expect(getTotalFee(20_707, 5_000, RESOURCE_FEE_RATES[0])).toBe(2_500 + 5_000 + 2_071);
    });
});
