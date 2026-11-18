// SPDX-FileCopyrightText: 2026 Nerva contributors
// SPDX-License-Identifier: LicenseRef-Proprietary

import { ConnectorJournalLimits } from '../../src/runtime/ConnectorJournalLimits.js';
import { open, mkdir, readFile, writeFile, type FileHandle } from 'node:fs/promises';
import { join } from 'node:path';
import type { BigIntStats } from 'node:fs';
import type { ConnectorDeviceLease } from 'nerva-connector-protocol/protocol/ConnectorDevice.js';
import { ExecutionFixture } from './ExecutionFixture.js';
import { ExecutionIdentity } from './ExecutionIdentity.js';
import { ExecutionPolicy } from '../../src/execution/ExecutionPolicy.js';
import { ExecutionPolicyCodec } from '../../src/execution/ExecutionPolicyCodec.js';
import { type ExecutionPolicyDefinition } from 'nerva-connector-protocol/execution/ExecutionPolicyTypes.js';
import { ExecutionArgumentKind } from 'nerva-connector-protocol/execution/ExecutionArgumentKind.js';
import {
    ExecutionWorkspaceAccess,
    type ExecutionResult,
} from 'nerva-connector-protocol/execution/ExecutionTypes.js';
import { ExecutionClient } from '../../src/execution/ExecutionClient.js';
import {
    type ExecutionRequest,
    type ExecutionPermit,
    type ExecutionCompletion,
} from 'nerva-connector-protocol/execution/ExecutionJobs.js';
import { ExecutionLane } from 'nerva-connector-protocol/execution/ExecutionLane.js';
import { ExecutionJournalCodec } from '../../src/execution/ExecutionJournalCodec.js';
import type { ExecutionClientSettings } from '../../src/execution/ExecutionClientSettings.js';
import type { ExecutionOutput } from 'nerva-connector-protocol/execution/ExecutionOutput.js';
import type { ConnectorClientIdentity } from '../../src/runtime/ConnectorClientConfiguration.js';
import { ConnectorOperationJournal } from '../../src/runtime/ConnectorOperationJournal.js';
import {
    ConnectorJournalState,
    type ConnectorJournalSnapshot,
} from '../../src/runtime/ConnectorJournalState.js';
import { ConnectorJournalCipher } from '../../src/runtime/ConnectorJournalCipher.js';
import { ProtectedFiles } from '../../src/local/ProtectedFiles.js';
import { JointWorkspaceConfiguration } from '../../src/workspace/JointWorkspaceConfiguration.js';
import { SignatureSuite } from 'nerva-connector-protocol/identity/IdentityFormat.js';
import {
    ExecutionEffectCase,
    ExecutionEffectPayload,
    requireEffect,
    type ExecutionEffectSettings,
    type ExecutionEffectCleanup,
} from './ExecutionEffectQualificationTypes.js';

/** A separate private journal and generated identity isolates each original without copying the native runtime. */
export interface ExecutionEffectLane {
    readonly label: ExecutionEffectCase;
    readonly settings: ExecutionClientSettings;
    readonly authority: ExecutionIdentity;
    readonly identity: ConnectorClientIdentity;
}

/** Owns one real runtime/policy, all fake pilot identities, and the pinned already-running interpreter image. */
export class ExecutionEffectQualificationState {
    private constructor(
        public readonly input: ExecutionEffectSettings,
        public readonly fixture: ExecutionFixture,
        public readonly interpreter: FileHandle,
        public readonly policy: ExecutionPolicy,
        public readonly lanes: ReadonlyMap<ExecutionEffectCase, ExecutionEffectLane>,
    ) {}

    /** All private paths are predeclared before one shared policy owner captures them. */
    public static async create(
        input: ExecutionEffectSettings,
    ): Promise<ExecutionEffectQualificationState> {
        const interpreter: FileHandle = await open('/proc/self/exe', 'r');
        let fixture: ExecutionFixture | null = null;
        let policy: ExecutionPolicy | null = null;
        const lanes: Map<ExecutionEffectCase, ExecutionEffectLane> = new Map();
        try {
            const image: BigIntStats = await interpreter.stat({ bigint: true });
            requireEffect(image.isFile() && (image.mode & 0o111n) !== 0n);
            fixture = await ExecutionFixture.create(input.helper, {
                workspaceParent: input.directory,
                runtimeParent: input.runtimeParent,
                delegationParent: input.delegation,
                probeFile: input.probe,
            });
            const policyFile: string = await fixture.policy(
                input.helper,
                ExecutionWorkspaceAccess.ReadWrite,
            );
            const original: ExecutionPolicyDefinition = ExecutionPolicyCodec.policy(
                JSON.parse(await readFile(policyFile, 'utf8')),
            );
            const definition: ExecutionPolicyDefinition = {
                ...original,
                programs: original.programs.map(
                    (program): ExecutionPolicyDefinition['programs'][number] => ({
                        ...program,
                        arguments: [
                            {
                                kind: ExecutionArgumentKind.Choice,
                                values: ['effect', 'output-hold'],
                            },
                        ],
                    }),
                ),
            };
            await writeFile(
                policyFile,
                JSON.stringify(definition, (_key: string, value: unknown): unknown =>
                    typeof value === 'bigint' ? value.toString() : value,
                ),
                { mode: 0o600 },
            );
            await fixture.installProfile(definition);
            const privatePaths: string[] = [];
            for (const label of Object.values(ExecutionEffectCase)) {
                if (label === ExecutionEffectCase.Input) {
                    continue;
                }
                const directory: string = join(fixture.directory, label);
                await mkdir(directory, { mode: 0o700 });
                const settings: ExecutionClientSettings = {
                    policyFile,
                    stateDirectory: join(directory, 'state'),
                    lane: ExecutionLane.First,
                };
                const authority: ExecutionIdentity = new ExecutionIdentity(directory, settings);
                const identity: ConnectorClientIdentity = authority.identity;
                const lane: ExecutionEffectLane = { label, settings, authority, identity };
                lanes.set(label, lane);
                await mkdir(settings.stateDirectory, { mode: 0o700 });
                await mkdir(join(settings.stateDirectory, settings.lane), { mode: 0o700 });
                const secret: Buffer = authority.device.encode();
                try {
                    await writeFile(identity.settings.privateKeyFile, secret, { mode: 0o600 });
                } finally {
                    secret.fill(0);
                }
                await writeFile(
                    identity.settings.authorityPublicKeyFile,
                    JSON.stringify({
                        suite: SignatureSuite.MlDsa44Ed25519,
                        publicKey: authority.authority.publicKey,
                    }),
                    { mode: 0o600 },
                );
                await writeFile(identity.configurationFile, JSON.stringify(identity.settings), {
                    mode: 0o600,
                });
                const workspace: ReturnType<typeof JointWorkspaceConfiguration.paths> =
                    JointWorkspaceConfiguration.paths(identity.settings.privateKeyFile);
                privatePaths.push(
                    workspace.configurationFile,
                    workspace.stateDirectory,
                    workspace.setupFile,
                    identity.configurationFile,
                    identity.settings.privateKeyFile,
                    identity.settings.authorityPublicKeyFile,
                    settings.stateDirectory,
                );
                await ConnectorOperationJournal.initialize(
                    join(settings.stateDirectory, settings.lane),
                    identity.settings.enrollmentId,
                    authority.device,
                    new ExecutionJournalCodec(settings.lane),
                );
            }
            policy = await ExecutionPolicy.load(policyFile, privatePaths);
            return new ExecutionEffectQualificationState(
                input,
                fixture,
                interpreter,
                policy,
                lanes,
            );
        } catch (caught: unknown) {
            try {
                await policy?.[Symbol.asyncDispose]();
            } finally {
                try {
                    await fixture?.release(true);
                } finally {
                    for (const lane of lanes.values()) {
                        lane.authority[Symbol.dispose]();
                    }
                    await interpreter.close();
                }
            }
            throw caught;
        }
    }

    /** No caller can select a different original identity or state directory through a remote argument. */
    public lane(label: ExecutionEffectCase): ExecutionEffectLane {
        const lane: ExecutionEffectLane | undefined = this.lanes.get(label);
        if (lane === undefined) {
            throw new Error('Missing owned qualification lane');
        }
        return lane;
    }

    /** Current product decoding independently verifies bytes even while the real client owns its journal lock. */
    public async read(
        lane: ExecutionEffectLane,
    ): Promise<ConnectorJournalSnapshot<ExecutionRequest, ExecutionResult, ExecutionOutput>> {
        const codec: ExecutionJournalCodec = new ExecutionJournalCodec(lane.settings.lane);
        using cipher: ConnectorJournalCipher<
            ConnectorJournalSnapshot<ExecutionRequest, ExecutionResult, ExecutionOutput>
        > = ConnectorJournalCipher.create(
            join(lane.settings.stateDirectory, lane.settings.lane),
            lane.identity.settings.enrollmentId,
            lane.authority.device,
            codec.purpose,
            new ConnectorJournalState(codec),
        );
        return cipher.decode(await this.cipher(lane)).state;
    }

    /** The input is bounded before allocation and never leaves the private qualification process. */
    public async cipher(lane: ExecutionEffectLane): Promise<Buffer> {
        return await ProtectedFiles.readPrivate(
            join(lane.settings.stateDirectory, lane.settings.lane, 'execution-journal'),
            ConnectorJournalLimits.recordBytes,
        );
    }

    /** Fixture initialization already created this exact current journal; normal consumers never reset it. */
    public async journal(
        lane: ExecutionEffectLane,
    ): Promise<ConnectorOperationJournal<ExecutionRequest, ExecutionResult, ExecutionOutput>> {
        return await ConnectorOperationJournal.load(
            join(lane.settings.stateDirectory, lane.settings.lane),
            lane.identity.settings.enrollmentId,
            lane.authority.device,
            new ExecutionJournalCodec(lane.settings.lane),
        );
    }

    /** The real device/authority handshake and publication code construct each unchanged original permit. */
    public async permit(
        lane: ExecutionEffectLane,
        payload: ExecutionEffectPayload = ExecutionEffectPayload.Effect,
    ): Promise<ExecutionPermit> {
        const lease: ConnectorDeviceLease = lane.authority.lease();
        await using client: ExecutionClient = await ExecutionClient.load(
            lane.identity,
            lane.settings,
            this.policy,
        );
        return lane.authority.permit(
            client.publication(lane.authority.session(lease)).profile,
            lease,
            payload,
        );
    }

    /** A renewed envelope never changes the original job, dispatch, request, sequence or policy. */
    public async execute(
        lane: ExecutionEffectLane,
        original: ExecutionPermit,
    ): Promise<ExecutionCompletion> {
        const lease: ConnectorDeviceLease = lane.authority.lease();
        const now: bigint = BigInt(Date.now());
        const permit: ExecutionPermit = lane.authority.sign({
            ...original,
            leaseId: lease.leaseId,
            issuedAtMs: now,
            expiresAtMs: now + 3000n,
            executionDeadlineMs: now + 5000n,
        });
        await using client: ExecutionClient = await ExecutionClient.load(
            lane.identity,
            lane.settings,
            this.policy,
        );
        return await client.execute(permit, lane.authority.session(lease));
    }

    /** Every nested case owner has joined before policies, descriptors and fake keys are released; files stay for controller cleanup. */
    public async release(): Promise<ExecutionEffectCleanup> {
        let clean: boolean = true;
        try {
            await this.policy[Symbol.asyncDispose]();
        } catch {
            clean = false;
        }
        if (clean) {
            try {
                await this.fixture.release(true);
            } catch {
                clean = false;
            }
        }
        for (const lane of this.lanes.values()) {
            lane.authority[Symbol.dispose]();
        }
        try {
            await this.interpreter.close();
        } catch {
            clean = false;
        }
        return {
            keysReleased: true,
            kernelQuiescent: clean,
            profilesRemoved: clean,
            descriptorsReleased: clean,
        };
    }
}
