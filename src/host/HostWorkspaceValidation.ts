// SPDX-FileCopyrightText: 2026 Dacely <business@dacely.com>
// SPDX-License-Identifier: LicenseRef-Proprietary

import { isAbsolute, resolve } from 'node:path';
import { ConnectorHostErrorCode } from 'nerva-connector-protocol/protocol/ConnectorHost.js';
import { HostOperationError } from './HostOperationError.js';
import { HostShell, HostWorkspaceLimits, type HostProcessRequest } from './HostWorkspaceTypes.js';

/**
 * Validation is repeated at the host operation boundary even for typed callers.
 *
 * @remarks
 * Path, offset and launch checks run before any effect, so their rejections are definitive `invalid-request`
 * failures. {@link HostWorkspaceValidation.count} also checks native results after an effect and therefore keeps
 * a plain error; a pre-effect caller states its own certainty.
 */
export class HostWorkspaceValidation {
    /** Host paths may address the whole computer, including outside the default workspace. */
    public static path(path: string, directory: string): string {
        if (
            typeof path !== 'string' ||
            path.length === 0 ||
            path.length > 32767 ||
            path.includes('\0')
        ) {
            throw this.#invalid(
                'Host paths must be non-empty, at most 32767 characters and without NUL',
            );
        }
        return resolve(directory, path);
    }

    /** Construction requires an explicit absolute initial directory. */
    public static directory(path: string): string {
        if (!isAbsolute(path)) {
            throw this.#invalid('Host workspace requires an absolute directory');
        }
        return this.path(path, path);
    }

    /** Controlled counts must remain finite exact integers within the operation's bound. */
    public static count(value: number, minimum: number, maximum: number): number {
        if (!Number.isSafeInteger(value) || value < minimum || value > maximum) {
            throw new Error('Host operation exceeds its resource limit');
        }
        return value;
    }

    /** Node filesystem APIs accept exact safe-number positions; reject unrepresentable offsets instead of rounding. */
    public static offset(value: bigint): number {
        if (typeof value !== 'bigint' || value < 0n || value > BigInt(Number.MAX_SAFE_INTEGER)) {
            throw this.#invalid('Host file offset is outside the supported exact range');
        }
        return Number(value);
    }

    /** Launch validation prevents ambiguous shell/executable contracts and unbounded argument allocation. */
    public static process(request: HostProcessRequest): void {
        if (
            request === null ||
            typeof request !== 'object' ||
            !Array.isArray(request.arguments) ||
            request.arguments.length > 1024 ||
            request.arguments.some((value: string): boolean => !this.#text(value, 32767)) ||
            request.arguments.reduce(
                (total: number, value: string): number => total + Buffer.byteLength(value),
                0,
            ) >
                1024 * 1024 ||
            request.environment === null ||
            typeof request.environment !== 'object' ||
            Array.isArray(request.environment)
        ) {
            throw this.#invalid(
                'Host launch requires at most 1024 string arguments totalling 1 MiB and an environment object',
            );
        }
        const environment: readonly [string, string][] = Object.entries(request.environment);
        if (
            environment.length > 256 ||
            environment.some(
                ([key, value]: [string, string]): boolean =>
                    !/^[^=\0]{1,256}$/u.test(key) || !this.#text(value, 32767),
            ) ||
            environment.reduce(
                (total: number, [key, value]: [string, string]): number =>
                    total + Buffer.byteLength(key) + Buffer.byteLength(value),
                0,
            ) >
                1024 * 1024
        ) {
            throw this.#invalid(
                'Host launch environment must be at most 256 NAME=value pairs and 1 MiB',
            );
        }
        if (request.shell === null) {
            if (
                !this.#text(request.executable, 32767) ||
                request.executable === '' ||
                request.command !== null
            ) {
                throw new HostOperationError(
                    ConnectorHostErrorCode.InvalidRequest,
                    'Executable mode requires executable and optional arguments. Omit command',
                    true,
                );
            }
        } else if (
            !Object.values(HostShell).includes(request.shell) ||
            !this.#text(request.command, 1024 * 1024) ||
            request.executable !== null ||
            request.arguments.length !== 0
        ) {
            throw new HostOperationError(
                ConnectorHostErrorCode.InvalidRequest,
                'Shell mode requires shell and command. Omit executable and arguments',
                true,
            );
        }
        if (
            !Number.isSafeInteger(request.timeoutMs) ||
            request.timeoutMs < 1 ||
            request.timeoutMs > HostWorkspaceLimits.timeoutMs
        ) {
            throw this.#invalid(
                `Host launch timeoutMs must be an integer from 1 to ${HostWorkspaceLimits.timeoutMs}`,
            );
        }
        if (
            request.retentionAfterTimeoutMs !== undefined &&
            (!Number.isSafeInteger(request.retentionAfterTimeoutMs) ||
                request.retentionAfterTimeoutMs < 1000 ||
                request.retentionAfterTimeoutMs > HostWorkspaceLimits.retentionAfterTimeoutMs)
        ) {
            throw this.#invalid(
                `Host launch retentionAfterTimeoutMs must be an integer from 1000 to ${HostWorkspaceLimits.retentionAfterTimeoutMs}`,
            );
        }
        if (request.directory !== null && !this.#text(request.directory, 32767)) {
            throw this.#invalid(
                'Host working directory must be at most 32767 characters without NUL',
            );
        }
    }

    static #invalid(message: string): HostOperationError {
        return new HostOperationError(ConnectorHostErrorCode.InvalidRequest, message, true);
    }

    static #text(value: string | null, maximum: number): boolean {
        return typeof value === 'string' && value.length <= maximum && !value.includes('\0');
    }
}
