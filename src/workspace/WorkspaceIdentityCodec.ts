// SPDX-FileCopyrightText: 2026 Dacely <business@dacely.com>
// SPDX-License-Identifier: LicenseRef-Proprietary

import { Boundary } from 'nerva-connector-protocol/protocol/Boundary.js';
import {
    WorkspaceIdentityFailure,
    type WorkspaceIdentityResult,
    type WorkspaceIdentity,
} from './WorkspaceIdentity.js';

/** Validates the fixed, bounded native diagnostic protocol without rounding filesystem integers. */
export class WorkspaceIdentityCodec {
    /** The native helper can return only one closed success or failure shape. */
    public static result(raw: unknown): WorkspaceIdentityResult {
        if (typeof raw !== 'object' || raw === null || !('ok' in raw)) {
            throw new Error('Invalid workspace inspection response');
        }
        if (raw.ok === false) {
            const failure: Readonly<Record<string, unknown>> = Boundary.record(raw, [
                'ok',
                'error',
            ]);
            const error: WorkspaceIdentityFailure | undefined = Object.values(
                WorkspaceIdentityFailure,
            ).find((entry: WorkspaceIdentityFailure): boolean => entry === failure['error']);
            if (Object.keys(failure).length !== 2 || error === undefined) {
                throw new Error('Invalid workspace inspection failure');
            }
            return { ok: false, error };
        }
        const value: Readonly<Record<string, unknown>> = Boundary.record(raw, ['ok', 'identity']);
        if (value['ok'] !== true || Object.keys(value).length !== 2) {
            throw new Error('Invalid workspace inspection identity');
        }
        return { ok: true, identity: this.identity(value['identity']) };
    }

    /** The same exact private identity shape is used for diagnostics and retained file provenance. */
    public static identity(raw: unknown): WorkspaceIdentity {
        const identity: Readonly<Record<string, unknown>> = Boundary.record(raw, [
            'filesystemUuid',
            'device',
            'inode',
            'handleType',
            'handle',
        ]);
        if (Object.keys(identity).length !== 5 || identity['handleType'] !== 1) {
            throw new Error('Invalid workspace inspection identity');
        }
        const filesystemUuid: string = this.#hex(identity['filesystemUuid'], 32);
        const inode: bigint = this.#integer(identity['inode']);
        if (filesystemUuid === '0'.repeat(32) || inode === 0n) {
            throw new Error('Workspace inspection requires a persistent filesystem identity');
        }
        return Object.freeze({
            filesystemUuid,
            device: this.#integer(identity['device']),
            inode,
            handleType: 1,
            handle: this.#hex(identity['handle'], 16),
        });
    }

    /** Typed native captures retain exact uint64 values while using the same closed identity validation. */
    public static value(value: WorkspaceIdentity): WorkspaceIdentity {
        return this.identity({
            ...value,
            device: this.#decimal(value.device),
            inode: this.#decimal(value.inode),
        });
    }

    /** Every physical comparison includes filesystem UUID, actual device, inode and the complete generation-bearing handle. */
    public static same(first: WorkspaceIdentity, second: WorkspaceIdentity): boolean {
        return (
            first.filesystemUuid === second.filesystemUuid &&
            first.device === second.device &&
            first.inode === second.inode &&
            first.handleType === second.handleType &&
            first.handle === second.handle
        );
    }

    static #decimal(value: bigint): string {
        if (typeof value !== 'bigint' || value < 0n || value > 18446744073709551615n) {
            throw new Error('Invalid private physical root integer');
        }
        return value.toString();
    }

    static #hex(value: unknown, length: number): string {
        if (typeof value !== 'string' || value.length !== length || !/^[a-f0-9]+$/u.test(value)) {
            throw new Error('Invalid workspace inspection encoding');
        }
        return value;
    }

    static #integer(value: unknown): bigint {
        if (typeof value !== 'string' || !/^(0|[1-9][0-9]{0,19})$/u.test(value)) {
            throw new Error('Invalid workspace inspection integer');
        }
        const parsed: bigint = BigInt(value);
        if (parsed > 18446744073709551615n) {
            throw new Error('Workspace inspection integer exceeds uint64');
        }
        return parsed;
    }
}
