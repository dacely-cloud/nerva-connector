// SPDX-FileCopyrightText: 2026 Dacely <business@dacely.com>
// SPDX-License-Identifier: LicenseRef-Proprietary

import { createHash } from 'node:crypto';
import { Boundary } from 'nerva-connector-protocol/protocol/Boundary.js';
import type { ConnectorPrivateDirectory } from '../runtime/ConnectorPrivateDirectory.js';

/** Preparation never exposes access; prepared history must exist before the runtime configuration is committed. */
export enum ConnectorCapabilityPhase {
    Preparing = 'preparing',
    Prepared = 'prepared',
    Active = 'active',
}
/** One original setup binds policy bytes, device/account identity and both configuration commitments. */
export interface ConnectorCapabilityRecord {
    readonly intentSha256: string;
    readonly originalSha256: string;
    readonly targetSha256: string;
    readonly phase: ConnectorCapabilityPhase;
}

/** Durable setup authority survives interrupted publication without making missing active journals fresh. */
export class ConnectorCapabilityState {
    /** Only an explicit current phase and complete bounded digest record can select recovery behavior. */
    public static async read(
        owner: ConnectorPrivateDirectory,
    ): Promise<ConnectorCapabilityRecord | null> {
        if (!(await owner.exists('intent.json'))) {
            return null;
        }
        const value: Readonly<Record<string, unknown>> = Boundary.record(
            JSON.parse(
                new TextDecoder('utf-8', { fatal: true }).decode(
                    await owner.read('intent.json', 4096),
                ),
            ),
            ['intentSha256', 'originalSha256', 'targetSha256', 'phase'],
        );
        const phase: ConnectorCapabilityPhase | undefined = Object.values(
            ConnectorCapabilityPhase,
        ).find((entry): boolean => entry === value['phase']);
        if (phase === undefined) {
            throw new Error('Unknown capability installation phase');
        }
        return {
            phase,
            intentSha256: this.#digest(value['intentSha256']),
            originalSha256: this.#digest(value['originalSha256']),
            targetSha256: this.#digest(value['targetSha256']),
        };
    }
    /** The caller owns installation/runtime exclusion; an existing intent is never silently replaced by a new policy. */
    public static async write(
        owner: ConnectorPrivateDirectory,
        record: ConnectorCapabilityRecord,
        initialize: boolean,
    ): Promise<void> {
        await owner.cleanPartial('intent.json', 4096);
        await owner.write('intent.json', Buffer.from(JSON.stringify(record)), 4096, initialize);
    }
    /** Exact source/configuration bytes are committed without storing another credential copy. */
    public static hash(bytes: Uint8Array | string): string {
        return createHash('sha256').update(bytes).digest('hex');
    }
    static #digest(raw: unknown): string {
        if (typeof raw !== 'string' || !/^[a-f0-9]{64}$/u.test(raw)) {
            throw new Error('Invalid capability installation commitment');
        }
        return raw;
    }
}
