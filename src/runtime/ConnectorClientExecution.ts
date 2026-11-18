// SPDX-FileCopyrightText: 2026 Nerva contributors
// SPDX-License-Identifier: LicenseRef-Proprietary

import { type ExecutionPublication } from 'nerva-connector-protocol/execution/ExecutionJobs.js';
import { ExecutionLane } from 'nerva-connector-protocol/execution/ExecutionLane.js';
import { ExecutionConfiguration } from '../execution/ExecutionConfiguration.js';
import { ExecutionAppArmorInstaller } from '../execution/ExecutionAppArmorInstaller.js';
import { ExecutionPolicy } from '../execution/ExecutionPolicy.js';
import { ExecutionClient } from '../execution/ExecutionClient.js';
import { ExecutionDelivery } from '../execution/ExecutionDelivery.js';
import { type ExecutionDeliveryLink } from '../execution/ExecutionDeliveryLink.js';
import {
    ConnectorFrameKind,
    type ConnectorExecutionServerFrame,
    type ConnectorInteractiveServerFrame,
} from '../protocol/ConnectorTransport.js';
import {
    ConnectorPrivateDirectory,
    ConnectorDirectoryPurpose,
} from './ConnectorPrivateDirectory.js';
import type { ConnectorJointAdmission } from './ConnectorJointAdmission.js';
import type { ConnectorClientIdentity } from './ConnectorClientConfiguration.js';
import type { ConnectorExecutionWorkspaceSource } from '../workspace/ConnectorWorkspaceSource.js';
import type { JointWorkspaceExecutionJournals } from 'nerva-connector-protocol/workspace/JointWorkspaceBinding.js';
import type { ExecutionProfile } from 'nerva-connector-protocol/execution/ExecutionJobs.js';
import type { ConnectorActivitySink } from './ConnectorActivity.js';

/** The normal CLI owns exactly two durable command lanes, independently of optional file tools and socket lifetimes. */
export class ConnectorClientExecution implements AsyncDisposable {
    readonly #resources: AsyncDisposableStack;
    readonly #lanes: ReadonlyMap<ExecutionLane, ExecutionDelivery>;
    readonly #workspaceSource: ConnectorExecutionWorkspaceSource;
    #closed: boolean = false;
    private constructor(
        resources: AsyncDisposableStack,
        lanes: ReadonlyMap<ExecutionLane, ExecutionDelivery>,
        policy: ExecutionPolicy,
    ) {
        this.#lanes = lanes;
        const first: ExecutionClient | undefined = lanes.get(ExecutionLane.First)?.client;
        const second: ExecutionClient | undefined = lanes.get(ExecutionLane.Second)?.client;
        if (first === undefined || second === undefined) {
            throw new Error('Both original execution lanes required');
        }
        const journals: JointWorkspaceExecutionJournals = Object.freeze({
            first: first.journalId,
            second: second.journalId,
        });
        const profile: ExecutionProfile = first.profile;
        const requireAvailable: () => void = (): void => this.#requireAvailable();
        this.#workspaceSource = Object.freeze({
            get quiescent(): boolean {
                requireAvailable();
                return [...lanes.values()].every(
                    (lane: ExecutionDelivery): boolean => lane.client.quiescent,
                );
            },
            get policy(): ExecutionPolicy {
                requireAvailable();
                return policy;
            },
            get profile(): ExecutionProfile {
                requireAvailable();
                return profile;
            },
            get journals(): JointWorkspaceExecutionJournals {
                requireAvailable();
                return journals;
            },
        });
        this.#resources = resources.move();
    }
    /**
     * Existing-only startup holds installation exclusion before loading either encrypted lane.
     *
     * @param activity - Receives each launched command and verified stop for the local activity screen; it never changes one
     */
    public static async load(
        identity: ConnectorClientIdentity,
        activity: ConnectorActivitySink | null = null,
    ): Promise<ConnectorClientExecution> {
        const settings: typeof identity.settings.execution = identity.settings.execution;
        if (settings === null) {
            throw new Error('Explicit local execution capability required');
        }
        await using resources: AsyncDisposableStack = new AsyncDisposableStack();
        resources.use(
            await ConnectorPrivateDirectory.open(
                settings.stateDirectory,
                ConnectorDirectoryPurpose.Execution,
            ),
        );
        const policy: ExecutionPolicy = resources.use(
            await ExecutionConfiguration.loadPolicy(identity, {
                ...settings,
                lane: ExecutionLane.First,
            }),
        );
        await ExecutionAppArmorInstaller.assertRequired(policy.definition);
        const lanes: Map<ExecutionLane, ExecutionDelivery> = new Map();
        for (const lane of Object.values(ExecutionLane)) {
            const client: ExecutionClient = await ExecutionClient.load(
                identity,
                {
                    ...settings,
                    lane,
                },
                policy,
                activity,
            );
            lanes.set(lane, resources.use(new ExecutionDelivery(client)));
        }
        return new ConnectorClientExecution(resources, lanes, policy);
    }
    /** Durability failure on either lane closes execution rather than silently resetting state. */
    public get failed(): boolean {
        return [...this.#lanes.values()].some(
            (lane: ExecutionDelivery): boolean => lane.client.failed,
        );
    }
    /** Stable live-owner projections expose existing capabilities without granting independent disposal ownership. */
    public get workspaceSource(): ConnectorExecutionWorkspaceSource {
        this.#requireAvailable();
        return this.#workspaceSource;
    }

    /** One metadata owner is shared by both already-loaded lanes; no socket or remote frame chooses this verifier. */
    public bindJointAdmission(owner: ConnectorJointAdmission): void {
        this.#requireAvailable();
        for (const lane of this.#lanes.values()) {
            lane.client.bindJointAdmission(owner);
        }
    }

    /** A confirmed socket publishes both original lane identities, without creating or resetting them. */
    public activate(link: ExecutionDeliveryLink): readonly ExecutionPublication[] {
        this.#requireAvailable();
        return [...this.#lanes.values()].map((lane: ExecutionDelivery): ExecutionPublication => {
            lane.activate(link);
            return lane.client.publication(link.session);
        });
    }
    /** Disconnect removes transport authority while leaving both process/journal owners alive. */
    public detach(link: ExecutionDeliveryLink): void {
        for (const lane of this.#lanes.values()) {
            lane.detach(link);
        }
    }
    /** The typed frame selects only an already loaded fixed lane. */
    public receive(
        frame: ConnectorExecutionServerFrame | ConnectorInteractiveServerFrame,
        link: ExecutionDeliveryLink,
    ): void {
        const id: ExecutionLane =
            frame.kind === ConnectorFrameKind.ExecutionInteractiveReadyStored
                ? frame.submission.ready.lane
                : frame.kind === ConnectorFrameKind.ExecutionInputWork
                  ? frame.original.lane
                  : frame.kind === ConnectorFrameKind.ExecutionPermit
                    ? frame.permit.lane
                    : frame.kind === ConnectorFrameKind.ExecutionCancellation
                      ? frame.cancellation.lane
                      : frame.acknowledgment.lane;
        const lane: ExecutionDelivery | undefined = this.#lanes.get(id);
        if (lane === undefined) {
            throw new Error('Execution lane unavailable');
        }
        lane.receive(frame, link);
    }
    /** All native descendants and durable result work finish before the installation lock and device key can be released. */
    public async [Symbol.asyncDispose](): Promise<void> {
        this.#closed = true;
        await this.#resources[Symbol.asyncDispose]();
    }
    #requireAvailable(): void {
        if (this.#closed || this.failed) {
            throw new Error('Connector execution workspace owner unavailable');
        }
    }
}
