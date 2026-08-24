import { FillLog } from '@cks-systems/manifest-sdk';
import { TransactionError } from '@solana/web3.js';
import { Cluster } from '@utils/cluster';
import { getTransactionInstructionError } from '@utils/program-err';
import { getProgramName } from '@utils/tx';

import { Logger } from '@/app/shared/lib/logger';

const MANIFEST_PROGRAM_ID = 'MNFSTqtC93rEfYHB6hF82sKdZpUDFWkViLByLd1k1Ms';
const PROGRAM_DATA_PREFIX = 'Program data: ';
const FILL_LOG_DISCRIMINATOR = Uint8Array.from([58, 230, 242, 3, 75, 113, 4, 169]);

export type LogMessage = {
    text: string;
    prefix: string;
    style: 'muted' | 'info' | 'success' | 'warning';
};

export type InstructionLogs = {
    invokedProgram: string | null;
    logs: LogMessage[];
    computeUnits: number;
    truncated: boolean;
    failed: boolean;
};

export function parseProgramLogs(
    logs: string[],
    error: TransactionError | null | undefined,
    cluster: Cluster,
): InstructionLogs[] {
    let depth = 0;
    const prettyLogs: InstructionLogs[] = [];
    function prefixBuilder(
        // Indent level starts at 1.
        indentLevel: number,
    ) {
        let prefix;
        if (indentLevel <= 0) {
            Logger.warn('[utils:program-logs] Tried to build a prefix for a program log at invalid indent level', {
                indentLevel,
            });
            prefix = '';
        } else {
            prefix = new Array(indentLevel - 1).fill('\u00A0\u00A0').join('');
        }
        return `${prefix}> `;
    }

    let prettyError;
    if (error) {
        prettyError = getTransactionInstructionError(error);
    }

    const currentProgram: string[] = [];
    logs.forEach(log => {
        if (log.startsWith('Program log:')) {
            // Use passive tense
            // eslint-disable-next-line no-restricted-syntax -- extract program log message
            log = log.replace(/Program log: (.*)/g, (match, p1) => {
                return `Program logged: "${p1}"`;
            });

            prettyLogs[prettyLogs.length - 1].logs.push({
                prefix: prefixBuilder(depth),
                style: 'muted',
                text: log,
            });
        } else if (log.startsWith(PROGRAM_DATA_PREFIX)) {
            prettyLogs[prettyLogs.length - 1].logs.push({
                prefix: prefixBuilder(depth),
                style: 'muted',
                text: log,
            });

            const manifestFillLog =
                currentProgram[currentProgram.length - 1] === MANIFEST_PROGRAM_ID ? decodeManifestFillLog(log) : null;
            if (manifestFillLog) {
                prettyLogs[prettyLogs.length - 1].logs.push({
                    prefix: prefixBuilder(depth),
                    style: 'muted',
                    text: manifestFillLog,
                });
            }
        } else if (log.startsWith('Log truncated')) {
            prettyLogs[prettyLogs.length - 1].truncated = true;
        } else {
            // eslint-disable-next-line no-restricted-syntax -- match program invoke pattern
            const regex = /Program (\w*) invoke \[(\d)\]/g;
            const matches = Array.from(log.matchAll(regex));

            if (matches.length > 0) {
                const programAddress = matches[0][1];
                currentProgram.push(programAddress);

                const programName = getProgramName(programAddress, cluster);

                if (depth === 0) {
                    prettyLogs.push({
                        computeUnits: 0,
                        failed: false,
                        invokedProgram: programAddress,
                        logs: [],
                        truncated: false,
                    });
                } else {
                    prettyLogs[prettyLogs.length - 1].logs.push({
                        prefix: prefixBuilder(depth),
                        style: 'info',
                        text: `Program invoked: ${programName}`,
                    });
                }

                depth++;
            } else if (log.includes('success')) {
                currentProgram.pop();
                prettyLogs[prettyLogs.length - 1].logs.push({
                    prefix: prefixBuilder(depth),
                    style: 'success',
                    text: `Program returned success`,
                });
                depth--;
            } else if (log.includes('failed')) {
                currentProgram.pop();
                const instructionLog = prettyLogs[prettyLogs.length - 1];
                instructionLog.failed = true;

                let currText = `Program returned error: "${log.slice(log.indexOf(': ') + 2)}"`;
                // failed to verify log of previous program so reset depth and print full log
                if (log.startsWith('failed')) {
                    depth++;
                    currText = log.charAt(0).toUpperCase() + log.slice(1);
                }

                instructionLog.logs.push({
                    prefix: prefixBuilder(depth),
                    style: 'warning',
                    text: currText,
                });
                depth--;
            } else {
                if (depth === 0) {
                    prettyLogs.push({
                        computeUnits: 0,
                        failed: false,
                        invokedProgram: null,
                        logs: [],
                        truncated: false,
                    });
                    depth++;
                }

                // Remove redundant program address from logs
                // eslint-disable-next-line no-restricted-syntax -- extract compute units consumed
                log = log.replace(/Program \w* consumed (\d*) (.*)/g, (match, p1, p2) => {
                    // Only aggregate compute units consumed from top-level tx instructions
                    // because they include inner ix compute units as well.
                    if (depth === 1) {
                        prettyLogs[prettyLogs.length - 1].computeUnits += Number.parseInt(p1);
                    }

                    return `Program consumed: ${p1} ${p2}`;
                });

                // native program logs don't start with "Program log:"
                prettyLogs[prettyLogs.length - 1].logs.push({
                    prefix: prefixBuilder(depth),
                    style: 'muted',
                    text: log,
                });
            }
        }
    });

    // If the instruction's simulation returned an error without any logs then add an empty log entry for Runtime error
    // For example BpfUpgradableLoader fails without returning any logs for Upgrade instruction with buffer that doesn't exist
    if (prettyError && prettyLogs.length === 0) {
        prettyLogs.push({
            computeUnits: 0,
            failed: true,
            invokedProgram: null,
            logs: [],
            truncated: false,
        });
    }

    if (prettyError && prettyError.index === prettyLogs.length - 1) {
        const failedIx = prettyLogs[prettyError.index];
        if (!failedIx.failed) {
            failedIx.failed = true;
            failedIx.logs.push({
                prefix: prefixBuilder(1),
                style: 'warning',
                text: `Runtime error: ${prettyError.message}`,
            });
        }
    }

    return prettyLogs;
}

// Manifest emits its fill events as `Program data:` payloads rather than self-CPI event
// instructions, so decode them here and render the pretty form alongside the raw base64.
function decodeManifestFillLog(log: string): string | null {
    const buffer = Buffer.from(log.substring(PROGRAM_DATA_PREFIX.length), 'base64');
    if (!isEqualBytes(FILL_LOG_DISCRIMINATOR, Uint8Array.from(buffer.subarray(0, 8)))) {
        return null;
    }

    const fillLog = FillLog.deserialize(buffer.subarray(8))[0];
    const pretty = fillLog.pretty();
    delete (pretty as Partial<typeof pretty>).padding;
    // TODO: Import convertU128 from manifest sdk, also factor in decimals to make human readable
    const readable = {
        ...pretty,
        baseAtoms: Number(fillLog.baseAtoms.inner),
        price: Number(fillLog.price.inner),
        quoteAtoms: Number(fillLog.quoteAtoms.inner),
    };

    return `MFX Fill Log: \n${JSON.stringify(readable, null, 2)}`;
}

export function isEqualBytes(bytes1: Uint8Array, bytes2: Uint8Array): boolean {
    if (bytes1.length !== bytes2.length) {
        return false;
    }

    for (let i = 0; i < bytes1.length; i++) {
        if (bytes1[i] !== bytes2[i]) {
            return false;
        }
    }

    return true;
}
