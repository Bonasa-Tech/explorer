/** `getMultipleAccounts` accepts at most 100 keys per request. */
const MAX_KEYS_PER_REQUEST = 100;

const BPF_UPGRADEABLE_LOADER = 'BPFLoaderUpgradeab1e11111111111111111111111';

/**
 * An upgradeable program account is `u32 enum tag` followed by the address of the account that
 * holds its bytecode, so 32 bytes at offset 4 is the programdata address.
 */
const PROGRAMDATA_ADDRESS_OFFSET = 4;
const PROGRAMDATA_ADDRESS_LENGTH = 32;

type RpcAccount = {
    space?: number;
    owner?: string;
    data?: [string, string];
} | null;

export type LoadedAccountsDataSize = {
    /** Total bytes the transaction loads, as far as this can be measured from outside the runtime. */
    totalBytes: number;
    /** How many of the requested addresses actually exist on chain. */
    resolvedCount: number;
    requestedCount: number;
    /** The portion of `totalBytes` contributed by programdata accounts. */
    programDataBytes: number;
};

async function getMultipleAccounts(
    addresses: string[],
    url: string,
    dataSlice: { offset: number; length: number },
): Promise<RpcAccount[]> {
    const accounts: RpcAccount[] = [];

    for (let offset = 0; offset < addresses.length; offset += MAX_KEYS_PER_REQUEST) {
        const batch = addresses.slice(offset, offset + MAX_KEYS_PER_REQUEST);
        const response = await fetch(url, {
            body: JSON.stringify({
                id: 1,
                jsonrpc: '2.0',
                method: 'getMultipleAccounts',
                params: [batch, { dataSlice, encoding: 'base64' }],
            }),
            headers: { 'Content-Type': 'application/json' },
            method: 'POST',
        });

        if (!response.ok) {
            throw new Error(`getMultipleAccounts failed: ${response.status} ${response.statusText}`);
        }

        const body = (await response.json()) as { error?: { message?: string }; result?: { value?: RpcAccount[] } };
        if (body.error) {
            throw new Error(`getMultipleAccounts failed: ${body.error.message ?? 'unknown RPC error'}`);
        }

        accounts.push(...(body.result?.value ?? []));
    }

    return accounts;
}

/** Decode a base58 address out of the 32 raw bytes returned for an upgradeable program account. */
function decodeProgramDataAddress(data: [string, string] | undefined): string | undefined {
    if (!data) return undefined;
    const bytes = Buffer.from(data[0], 'base64');
    if (bytes.length !== PROGRAMDATA_ADDRESS_LENGTH) return undefined;
    return base58Encode(bytes);
}

const BASE58_ALPHABET = '123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz';

function base58Encode(bytes: Buffer): string {
    let value = 0n;
    for (const byte of bytes) value = (value << 8n) + BigInt(byte);

    let encoded = '';
    while (value > 0n) {
        encoded = BASE58_ALPHABET[Number(value % 58n)] + encoded;
        value /= 58n;
    }
    // Leading zero bytes are encoded as leading '1's rather than dropped.
    for (const byte of bytes) {
        if (byte !== 0) break;
        encoded = `1${encoded}`;
    }
    return encoded;
}

/**
 * Measure how much account data a transaction actually loads.
 *
 * The RPC reports `space` as an account's full data length regardless of `dataSlice`, so slicing to
 * a 32-byte window gets every size without downloading any bytecode. That window is aimed at the
 * programdata pointer inside upgradeable program accounts: the program account itself is only 36
 * bytes, but the runtime also loads the programdata account holding its bytecode, which is usually
 * the largest thing a transaction touches. Missing those would undercount by megabytes.
 *
 * This still reads slightly low against the runtime's own figure, which additionally charges for
 * each distinct loader account. Addresses with no account on chain contribute nothing, since a
 * transaction may reference an account it is about to create.
 */
export async function fetchLoadedAccountsDataSize(addresses: string[], url: string): Promise<LoadedAccountsDataSize> {
    const accounts = await getMultipleAccounts(addresses, url, {
        length: PROGRAMDATA_ADDRESS_LENGTH,
        offset: PROGRAMDATA_ADDRESS_OFFSET,
    });

    let totalBytes = 0;
    let resolvedCount = 0;
    const programDataAddresses: string[] = [];

    for (const account of accounts) {
        if (!account || typeof account.space !== 'number') continue;
        resolvedCount++;
        totalBytes += account.space;

        if (account.owner === BPF_UPGRADEABLE_LOADER) {
            const programDataAddress = decodeProgramDataAddress(account.data);
            if (programDataAddress) programDataAddresses.push(programDataAddress);
        }
    }

    let programDataBytes = 0;
    if (programDataAddresses.length > 0) {
        const programData = await getMultipleAccounts(programDataAddresses, url, { length: 0, offset: 0 });
        for (const account of programData) {
            if (account && typeof account.space === 'number') programDataBytes += account.space;
        }
        totalBytes += programDataBytes;
    }

    return { programDataBytes, requestedCount: addresses.length, resolvedCount, totalBytes };
}
