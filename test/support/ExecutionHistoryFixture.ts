// SPDX-FileCopyrightText: 2026 Dacely <business@dacely.com>
// SPDX-License-Identifier: LicenseRef-Proprietary

import { createHash } from 'node:crypto';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { ExecutionIdentity } from './ExecutionIdentity.js';
import { SignatureSuite } from 'nerva-connector-protocol/identity/IdentityFormat.js';
import type { ConnectorClientIdentity } from '../../src/runtime/ConnectorClientConfiguration.js';
import { ConnectorOperationJournal } from '../../src/runtime/ConnectorOperationJournal.js';
import { ConnectorJournalStore } from '../../src/runtime/ConnectorJournalStore.js';
import {
    ConnectorJournalState,
    type ConnectorJournalSnapshot,
} from '../../src/runtime/ConnectorJournalState.js';
import type { ConnectorOperationDispatch } from 'nerva-connector-protocol/protocol/ConnectorOperationDispatch.js';
import { type ExecutionRequest } from 'nerva-connector-protocol/execution/ExecutionJobs.js';
import { ExecutionLane } from 'nerva-connector-protocol/execution/ExecutionLane.js';
import { ExecutionJournalCodec } from '../../src/execution/ExecutionJournalCodec.js';
import { ExecutionProof } from 'nerva-connector-protocol/execution/ExecutionProof.js';
import {
    ConnectorAuthorizationKind,
    type ConnectorAuthorization,
} from 'nerva-connector-protocol/protocol/ConnectorAuthorization.js';
import { ConnectorAuthorizationProof } from 'nerva-connector-protocol/protocol/ConnectorAuthorizationProof.js';
import type { ExecutionOutput } from 'nerva-connector-protocol/execution/ExecutionOutput.js';
import {
    ExecutionWorkspaceAccess,
    type ExecutionResult,
} from 'nerva-connector-protocol/execution/ExecutionTypes.js';
import type { ExecutionPolicyDefinition } from 'nerva-connector-protocol/execution/ExecutionPolicyTypes.js';

export class ExecutionHistoryFixture implements AsyncDisposable {
    public readonly authority: ExecutionIdentity;
    public readonly identity: ConnectorClientIdentity;
    public readonly policy: string;
    public readonly state: string;
    public readonly definition: ExecutionPolicyDefinition;
    public readonly digest: string;

    private constructor(public readonly directory: string) {
        this.authority = new ExecutionIdentity(directory);
        this.policy = join(directory, 'original-policy.json');
        this.state = join(directory, 'execution-state');
        this.identity = {
            ...this.authority.identity,
            settings: {
                ...this.authority.identity.settings,
                execution: { policyFile: this.policy, stateDirectory: this.state },
            },
        };
        this.definition = {
            revision: 1n,
            installationId: 'a'.repeat(32),
            trampolineFile: join(directory, 'removed-helper'),
            trampolineSha256: 'a'.repeat(64),
            bubblewrapFile: join(directory, 'removed-bwrap'),
            bubblewrapSha256: 'b'.repeat(64),
            runtimeDirectory: join(directory, 'removed-runtime'),
            cgroupRoot: '/sys/fs/cgroup/absent-original-history-fixture',
            roots: [
                {
                    id: 'root',
                    path: join(directory, 'removed-workspace'),
                    access: ExecutionWorkspaceAccess.ReadWrite,
                },
            ],
            programs: [
                {
                    id: 'program',
                    path: '/usr/bin/removed',
                    sha256: 'c'.repeat(64),
                    rootIds: ['root'],
                    arguments: [],
                    children: [],
                },
            ],
            resources: { memoryBytes: 33554432n, maximumTasks: 2, cpuQuotaMicros: 1000 },
            timeoutMs: 1000,
            maximumAddressBytes: 67108864n,
            maximumFileBytes: 0n,
        };
        this.digest = createHash('sha256')
            .update(ExecutionHistoryFixture.encode(this.definition))
            .digest('hex');
    }

    /** Missing executable/runtime references deliberately prove this role never opens them. */
    public static async create(): Promise<ExecutionHistoryFixture> {
        const fixture: ExecutionHistoryFixture = new ExecutionHistoryFixture(
            await mkdtemp(join(homedir(), '.nerva-history-preparation-')),
        );
        try {
            const secret: Buffer = fixture.identity.key.encode();
            try {
                await writeFile(fixture.identity.settings.privateKeyFile, secret, { mode: 0o600 });
            } finally {
                secret.fill(0);
            }
            await writeFile(
                fixture.identity.settings.authorityPublicKeyFile,
                JSON.stringify({
                    suite: SignatureSuite.MlDsa44Ed25519,
                    publicKey: fixture.identity.authority.publicKey,
                }),
                { mode: 0o600 },
            );
            await writeFile(
                fixture.identity.configurationFile,
                JSON.stringify(fixture.identity.settings),
                { mode: 0o600 },
            );
            await mkdir(fixture.state, { mode: 0o700 });
            await writeFile(fixture.policy, this.encode(fixture.definition), { mode: 0o600 });
            for (const lane of Object.values(ExecutionLane)) {
                await mkdir(join(fixture.state, lane), { mode: 0o700 });
                await ConnectorOperationJournal.initialize(
                    join(fixture.state, lane),
                    fixture.identity.settings.enrollmentId,
                    fixture.identity.key,
                    new ExecutionJournalCodec(lane),
                );
            }
            return fixture;
        } catch (caught: unknown) {
            await fixture[Symbol.asyncDispose]();
            throw caught;
        }
    }

    /** Policy byte identity includes original formatting rather than a reserialized digest. */
    public static encode(definition: ExecutionPolicyDefinition): string {
        return (
            JSON.stringify(definition, (_key: string, value: unknown): unknown =>
                typeof value === 'bigint' ? value.toString() : value,
            ) + '\n'
        );
    }

    /** Requests retain canary arguments that must never appear in a preparation report. */
    public dispatch(
        lane: ExecutionLane,
        digest: string = this.digest,
        sequence: bigint = 1n,
    ): ConnectorOperationDispatch<ExecutionRequest> {
        const request: ExecutionRequest = {
            requestId: 'request-' + lane,
            policySha256: digest,
            programId: 'program',
            rootId: 'root',
            arguments: ['PRIVATE_ARGUMENT_CANARY'],
        };
        const authorization: ConnectorAuthorization = {
            kind: ConnectorAuthorizationKind.Independent,
        };
        const requestHash: string = ExecutionProof.requestHash(request);
        return {
            jobId: 'job-' + lane,
            sequence,
            dispatchId: Buffer.alloc(32, lane === ExecutionLane.First ? 0 : 1).toString(
                'base64url',
            ),
            requestHash,
            authorization,
            admissionHash: ConnectorAuthorizationProof.execution(requestHash, lane, authorization),
            request,
        };
    }

    /** Every read uses the unchanged production key purpose, AAD and lane lock. */
    public async load(
        lane: ExecutionLane,
    ): Promise<ConnectorOperationJournal<ExecutionRequest, ExecutionResult, ExecutionOutput>> {
        return await ConnectorOperationJournal.load(
            join(this.state, lane),
            this.identity.settings.enrollmentId,
            this.identity.key,
            new ExecutionJournalCodec(lane),
        );
    }

    /** Ciphertext equality proves terminal/blocked preparation did not rewrite retained user data. */
    public async bytes(lane: ExecutionLane): Promise<Buffer> {
        return await readFile(join(this.state, lane, 'execution-journal'));
    }

    /** Test-only state construction covers counters beyond Number precision without altering production APIs. */
    public async snapshot(
        lane: ExecutionLane,
        snapshot: ConnectorJournalSnapshot<ExecutionRequest, ExecutionResult, ExecutionOutput>,
    ): Promise<void> {
        const codec: ExecutionJournalCodec = new ExecutionJournalCodec(lane);
        const state: ConnectorJournalState<ExecutionRequest, ExecutionResult, ExecutionOutput> =
            new ConnectorJournalState(codec);
        await using store: ConnectorJournalStore<
            ConnectorJournalSnapshot<ExecutionRequest, ExecutionResult, ExecutionOutput>
        > = await ConnectorJournalStore.open(
            join(this.state, lane),
            this.identity.settings.enrollmentId,
            this.identity.key,
            codec.purpose,
            state,
        );
        await store.write(snapshot, false);
    }

    /** All test keys and exact owned temporary state are removed after preparation owners have joined. */
    public async [Symbol.asyncDispose](): Promise<void> {
        this.authority[Symbol.dispose]();
        await rm(this.directory, { recursive: true, force: true });
    }
}
