// SPDX-FileCopyrightText: 2026 Nerva contributors
// SPDX-License-Identifier: LicenseRef-Proprietary

import { readFile, readdir } from 'node:fs/promises';
import { join } from 'node:path';
import { expect, it } from 'vitest';
import { ExecutionFixture } from './support/ExecutionFixture.js';
import { ExecutionIdentity } from './support/ExecutionIdentity.js';
import { setup } from './support/ExecutionSetup.js';
import { ExecutionConfiguration } from '../src/execution/ExecutionConfiguration.js';
import { ExecutionPolicy } from '../src/execution/ExecutionPolicy.js';
import { ConnectorJournalStore } from '../src/runtime/ConnectorJournalStore.js';
import { ConnectorJournalLimits } from '../src/runtime/ConnectorJournalLimits.js';
import {
    ConnectorOperationPurpose,
    type ConnectorStorageCodec,
} from '../src/runtime/ConnectorOperationCodec.js';
import { ConnectorEffectContextCodec } from '../src/runtime/ConnectorEffectContextCodec.js';
import type { ConnectorEffectContext } from '../src/runtime/ConnectorEffectContext.js';
import {
    ConnectorAuthorizationKind,
    type ConnectorAuthorization,
} from 'nerva-connector-protocol/protocol/ConnectorAuthorization.js';
import { ConnectorAuthorizationCodec } from 'nerva-connector-protocol/protocol/ConnectorAuthorizationCodec.js';
import { ConnectorFileMode } from 'nerva-connector-protocol/protocol/ConnectorFiles.js';
import { Boundary } from 'nerva-connector-protocol/protocol/Boundary.js';
import { JointWorkspaceProof } from '../src/workspace/JointWorkspaceProof.js';

/** This storage-only payload is deliberately outside remote file/command grammars; it proves the complete prior plaintext allowance is retained. */
interface AuthorizedStorageRecord {
    readonly payload: string;
    readonly authorization: ConnectorAuthorization;
    readonly effectContext: ConnectorEffectContext;
}

/** The real encrypted store still bounds the whole authenticated record; no test codec participates in remote authority or native launch. */
class AuthorizedStorageCodec implements ConnectorStorageCodec<AuthorizedStorageRecord> {
    public read(raw: unknown): AuthorizedStorageRecord {
        const record: Readonly<Record<string, unknown>> = Boundary.record(raw, [
            'payload',
            'authorization',
            'effectContext',
        ]);
        const payload: unknown = record['payload'];
        if (typeof payload !== 'string' || payload.length > ConnectorJournalLimits.plainBytes) {
            throw new Error('Bounded test payload required');
        }
        return {
            payload,
            authorization: ConnectorAuthorizationCodec.read(record['authorization']),
            effectContext: ConnectorEffectContextCodec.read(record['effectContext']),
        };
    }
    public encode(record: AuthorizedStorageRecord): string {
        if (record.payload.length > ConnectorJournalLimits.plainBytes) {
            throw new Error('Bounded test payload required');
        }
        const rawContext: unknown = JSON.parse(
            ConnectorEffectContextCodec.encode(record.effectContext),
        );
        return JSON.stringify(
            {
                payload: record.payload,
                authorization: ConnectorAuthorizationCodec.value(record.authorization),
                effectContext: ConnectorEffectContextCodec.read(rawContext),
            },
            (_key: string, entry: unknown): unknown =>
                typeof entry === 'bigint' ? entry.toString() : entry,
        );
    }
}

const helper: string | undefined = process.env['NERVA_CONNECTOR_EXEC_HELPER'];
it.skipIf(helper === undefined || process.env['NERVA_CONNECTOR_FILES_HELPER'] === undefined)(
    'the full prior plaintext allowance plus maximum-field joint authorization and actual private native effect context fits the new fixed storage budget, while oversize fails atomically',
    async (): Promise<void> => {
        if (helper === undefined) {
            throw new Error('Explicit actual native helper required');
        }
        await using fixture: ExecutionFixture = await ExecutionFixture.create(helper);
        const settings: Awaited<ReturnType<typeof setup>> = await setup(fixture);
        using identity: ExecutionIdentity = new ExecutionIdentity(fixture.directory, settings);
        await using policy: ExecutionPolicy = await ExecutionConfiguration.loadPolicy(
            identity.identity,
            settings,
        );
        const effectContext: Awaited<ReturnType<typeof policy.effectContext>> =
            await policy.effectContext('project');
        const authorization: ConnectorAuthorization = {
            kind: ConnectorAuthorizationKind.Joint,
            binding: JointWorkspaceProof.sign(identity.device, {
                authorityId: 'a'.repeat(128),
                environmentId: 'e'.repeat(128),
                enrollmentId: identity.identity.settings.enrollmentId,
                revision: 9223372036854775807n,
                filePolicySha256: 'a'.repeat(64),
                executionPolicySha256: policy.policySha256,
                fileRootId: 'f'.repeat(128),
                executionRootId: 'c'.repeat(128),
                access: ConnectorFileMode.ReadWrite,
                physicalRootCommitment: 'c'.repeat(64),
                fileJournalId: 'd'.repeat(64),
                executionJournals: { first: 'e'.repeat(64), second: 'f'.repeat(64) },
            }),
        };
        const payload: string = 'x'.repeat(
            ConnectorJournalLimits.originalPlainBytes -
                Buffer.byteLength(JSON.stringify({ payload: '' })),
        );
        expect(Buffer.byteLength(JSON.stringify({ payload }))).toBe(
            ConnectorJournalLimits.originalPlainBytes,
        );
        const record: AuthorizedStorageRecord = { payload, authorization, effectContext };
        const codec: AuthorizedStorageCodec = new AuthorizedStorageCodec();
        expect(Buffer.byteLength(codec.encode(record))).toBeLessThanOrEqual(
            ConnectorJournalLimits.plainBytes,
        );
        await using store: ConnectorJournalStore<AuthorizedStorageRecord> =
            await ConnectorJournalStore.open(
                fixture.directory,
                identity.identity.settings.enrollmentId,
                identity.device,
                ConnectorOperationPurpose.ExecutionFirst,
                codec,
            );
        await store.write(record, true);
        const file: string = join(fixture.directory, 'execution-journal');
        const preserved: Buffer = await readFile(file);
        expect(preserved.byteLength).toBeLessThanOrEqual(ConnectorJournalLimits.recordBytes);
        const read: AuthorizedStorageRecord = await store.read();
        expect(read.payload).toBe(payload);
        expect(ConnectorAuthorizationCodec.encode(read.authorization)).toBe(
            ConnectorAuthorizationCodec.encode(authorization),
        );
        expect(read.effectContext).toEqual(effectContext);
        const overhead: number = Buffer.byteLength(codec.encode({ ...record, payload: '' }));
        const maximum: AuthorizedStorageRecord = {
            ...record,
            payload: 'x'.repeat(ConnectorJournalLimits.plainBytes - overhead),
        };
        expect(Buffer.byteLength(codec.encode(maximum))).toBe(ConnectorJournalLimits.plainBytes);
        await store.write(maximum, false);
        expect((await store.read()).payload).toBe(maximum.payload);
        const before: Buffer = await readFile(file);
        expect(before.byteLength).toBeGreaterThan(196608);
        expect(before.byteLength).toBeLessThanOrEqual(ConnectorJournalLimits.recordBytes);
        const names: readonly string[] = await readdir(fixture.directory);
        await expect(
            store.write(
                { ...record, payload: 'x'.repeat(ConnectorJournalLimits.plainBytes) },
                false,
            ),
        ).rejects.toThrow();
        expect(await readFile(file)).toEqual(before);
        expect(await readdir(fixture.directory)).toEqual(names);
    },
    15000,
);
