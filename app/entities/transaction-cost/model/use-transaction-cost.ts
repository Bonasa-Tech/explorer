import type { VersionedMessage } from '@solana/web3.js';
import useSWR from 'swr';

import { fetchLoadedAccountsDataSize, type LoadedAccountsDataSize } from '../api/fetch-account-data-sizes';
import {
    type CostUnitBreakdown,
    getCostUnitBreakdown,
    LAMPORTS_PER_SIGNATURE,
    MAX_LOADED_ACCOUNTS_DATA_SIZE_BYTES,
    type PrecompileSignatureCounts,
} from '../lib/cost-model';
import { extractMessageCostInputs, getRequestedLoadedAccountsDataSize } from '../lib/extract-cost-inputs';

/**
 * One priced view of a transaction. The two views differ only in the loaded-accounts data size fed
 * into the cost model.
 */
export type TransactionCostEstimate = {
    breakdown: CostUnitBreakdown;
    /** The loaded-accounts data size, in bytes, this estimate was priced on. */
    loadedAccountsDataSizeBytes: number;
};

/** The cost inputs read off the transaction, kept so the UI can show the arithmetic. */
export type TransactionCostInputs = {
    numTransactionSignatures: number;
    precompileSignatures: PrecompileSignatureCounts;
    numWriteLocks: number;
    instructionDataBytes: number;
    requestedComputeUnits: number;
};

export type TransactionCost = {
    inputs: TransactionCostInputs;
    /**
     * Priced on the data size the transaction actually requested — the 64 MiB default unless it
     * carries a `SetLoadedAccountsDataSizeLimit` instruction. This is what the runtime charges,
     * so it should match `meta.costUnits`.
     */
    requested: TransactionCostEstimate;
    /**
     * Priced on the summed size of the accounts the transaction really touches. Present only once
     * the account fetch resolves. This is what the transaction *would* cost if it declared a
     * limit that matched its actual footprint.
     */
    actual: TransactionCostEstimate | undefined;
    /** True when the transaction left the loaded-accounts data size on the 64 MiB default. */
    usesDefaultDataSizeLimit: boolean;
    /** Lamports paid for prioritization, backed out of the fee actually charged. */
    priorityFeeLamports: number;
    /** What the account lookup found, once it resolves. */
    measured: LoadedAccountsDataSize | undefined;
    loading: boolean;
    error: Error | undefined;
};

export type UseTransactionCostArgs = {
    /** The compiled message. Absent for v1, which does not expose one. */
    message: VersionedMessage | undefined;
    /** Every account the transaction loads, including addresses resolved from lookup tables. */
    accountKeys: string[] | undefined;
    /** The requested compute unit limit, as the summary card already computes it. */
    requestedComputeUnits: number | undefined;
    /** The fee actually charged, used to back out the priority fee. */
    feeLamports: number | undefined;
    url: string;
};

/**
 * Price a transaction under SGP-0003, both as the runtime bills it today and as it would be billed
 * if its loaded-accounts data size limit matched what it actually loads.
 *
 * Everything except the account sizes comes off the transaction itself; the sizes need a lookup,
 * so the `actual` estimate arrives after the `requested` one.
 */
export function useTransactionCost({
    message,
    accountKeys,
    requestedComputeUnits,
    feeLamports,
    url,
}: UseTransactionCostArgs): TransactionCost | undefined {
    const shouldFetch = accountKeys !== undefined && accountKeys.length > 0;
    const {
        data: measured,
        error,
        isLoading,
    } = useSWR(
        // eslint-disable-next-line unicorn/no-null -- SWR uses a null key to disable the request
        shouldFetch ? ['transaction-cost-account-sizes', accountKeys.join(','), url] : null,
        () => fetchLoadedAccountsDataSize(accountKeys as string[], url),
        { revalidateOnFocus: false },
    );

    if (!message || requestedComputeUnits === undefined) return undefined;

    const messageInputs = extractMessageCostInputs(message);
    // Write locks are counted off the resolved key list, so lookup-table addresses are included.
    const numWriteLocks = countWriteLocks(message);
    const sharedInputs: TransactionCostInputs = {
        instructionDataBytes: messageInputs.instructionDataBytes,
        numTransactionSignatures: messageInputs.numTransactionSignatures,
        numWriteLocks,
        precompileSignatures: messageInputs.precompileSignatures,
        requestedComputeUnits,
    };

    const requestedDataSize = getRequestedLoadedAccountsDataSize(messageInputs.requestedLoadedAccountsDataSize);
    const requested: TransactionCostEstimate = {
        breakdown: getCostUnitBreakdown({ ...sharedInputs, loadedAccountsDataSizeBytes: requestedDataSize }),
        loadedAccountsDataSizeBytes: requestedDataSize,
    };

    let actual: TransactionCostEstimate | undefined;
    if (measured) {
        actual = {
            breakdown: getCostUnitBreakdown({
                ...sharedInputs,
                loadedAccountsDataSizeBytes: measured.totalBytes,
            }),
            loadedAccountsDataSizeBytes: measured.totalBytes,
        };
    }

    // Today's fee is 5,000 lamports per signature plus prioritization; the remainder is the latter.
    const priorityFeeLamports =
        feeLamports === undefined
            ? 0
            : Math.max(0, feeLamports - messageInputs.numTransactionSignatures * LAMPORTS_PER_SIGNATURE);

    return {
        actual,
        error: error as Error | undefined,
        inputs: sharedInputs,
        loading: isLoading,
        measured,
        priorityFeeLamports,
        requested,
        usesDefaultDataSizeLimit: requestedDataSize === MAX_LOADED_ACCOUNTS_DATA_SIZE_BYTES,
    };
}

/**
 * Count the transaction's write locks, including addresses pulled in from lookup tables.
 *
 * `isAccountWritable` indexes into the fully resolved key space, so the loop has to run past the
 * static keys and over the lookup-table entries the message declares.
 */
function countWriteLocks(message: VersionedMessage): number {
    const lookupKeyCount = message.addressTableLookups.reduce(
        (total, lookup) => total + lookup.writableIndexes.length + lookup.readonlyIndexes.length,
        0,
    );
    const totalKeys = message.staticAccountKeys.length + lookupKeyCount;

    let writable = 0;
    for (let index = 0; index < totalKeys; index++) {
        if (message.isAccountWritable(index)) writable++;
    }
    return writable;
}
