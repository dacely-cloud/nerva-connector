// SPDX-FileCopyrightText: 2026 Dacely <business@dacely.com>
// SPDX-License-Identifier: LicenseRef-Proprietary

import { ExecutionInputJournalFixture } from './ExecutionInputJournalFixture.js';
import {
    ExecutionPipeFixture,
    ExecutionPipeProbe,
    type ExecutionPipeInvocation,
} from './ExecutionPipeFixture.js';
import { ExecutionInputJournalOwner } from '../../src/execution/ExecutionInputJournalOwner.js';
import { ExecutionInteractiveRuntime } from '../../src/execution/ExecutionInteractiveRuntime.js';
import { randomBytes } from 'node:crypto';
import { ExecutionMachineMode } from 'nerva-connector-protocol/execution/ExecutionMachineInvocation.js';
import { ExecutionInteractiveTransport } from 'nerva-connector-protocol/execution/ExecutionInteractive.js';
import type {
    ExecutionInteractiveInvocationRule,
    ExecutionInteractiveLaunch,
} from 'nerva-connector-protocol/execution/ExecutionInteractiveInvocation.js';
import {
    ExecutionInputKind,
    type ExecutionInputPermit,
    type ExecutionInputPermitBody,
    type ExecutionInputCursor,
} from 'nerva-connector-protocol/execution/ExecutionInput.js';
import { ExecutionInputPermitCodec } from 'nerva-connector-protocol/execution/ExecutionInputPermitCodec.js';
import type {
    ExecutionPermit,
    ExecutionRequest,
} from 'nerva-connector-protocol/execution/ExecutionJobs.js';
import { ExecutionProof } from 'nerva-connector-protocol/execution/ExecutionProof.js';
import { ExecutionInteractiveProof as Proof } from 'nerva-connector-protocol/execution/ExecutionInteractiveProof.js';
import { ConnectorAuthorizationProof } from 'nerva-connector-protocol/protocol/ConnectorAuthorizationProof.js';
import { SignaturePurpose } from 'nerva-connector-protocol/identity/IdentityFormat.js';
import { ExecutionWorkspaceAccess } from 'nerva-connector-protocol/execution/ExecutionTypes.js';

/** Only the owning test may advance its receiver clock; global time and native sandbox deadlines remain untouched. */
export class ExecutionInteractiveRuntimeClock {
    #sample: bigint | null = null;
    public now(): bigint {
        return this.#sample ?? BigInt(Date.now());
    }
    public advanceTo(value: bigint): void {
        if (value < this.now()) {
            throw new Error('Fixture receiver clock cannot move backwards');
        }
        this.#sample = value;
    }
}

/** Actual kernel I/O and encrypted state compose with disposable genuine cryptographic identities; this is not real account/API admission. */
export class ExecutionInteractiveRuntimeFixture implements AsyncDisposable {
    readonly #resources: AsyncDisposableStack;
    private constructor(
        resources: AsyncDisposableStack,
        public readonly signed: ExecutionInputJournalFixture,
        public readonly native: ExecutionPipeFixture,
        public readonly journal: ExecutionInputJournalOwner,
        public readonly invocation: ExecutionPipeInvocation,
        public readonly runtime: ExecutionInteractiveRuntime,
        public readonly stop: AbortController,
        public readonly startPermit: ExecutionPermit,
        public readonly clock: ExecutionInteractiveRuntimeClock,
    ) {
        this.#resources = resources;
    }

    public static async create(
        helper: string,
        action: ExecutionPipeProbe = ExecutionPipeProbe.Echo,
        initial: string = '',
        timeoutMs: number = 3000,
    ): Promise<ExecutionInteractiveRuntimeFixture> {
        await using resources: AsyncDisposableStack = new AsyncDisposableStack();
        const signed: ExecutionInputJournalFixture = resources.use(
            await ExecutionInputJournalFixture.create(),
        );
        const native: ExecutionPipeFixture = resources.use(
            await ExecutionPipeFixture.create(helper),
        );
        const journal: ExecutionInputJournalOwner = resources.use(
            await ExecutionInputJournalOwner.open(
                signed.directory,
                signed.peer.identity,
                signed.scope,
            ),
        );
        const stop: AbortController = new AbortController();
        const clock: ExecutionInteractiveRuntimeClock = new ExecutionInteractiveRuntimeClock();
        const original: ExecutionInteractiveInvocationRule = signed.rule();
        const rule: ExecutionInteractiveInvocationRule = {
            ...original,
            invocation: {
                ...original.invocation,
                shell: null,
                commands: [{ alias: 'probe', executableIndex: 0 }],
                maximumScriptBytes: 0,
            },
        };
        const now: bigint = BigInt(Date.now());
        const launch: ExecutionInteractiveLaunch = {
            transport: ExecutionInteractiveTransport.Pipe,
            invocation: {
                mode: ExecutionMachineMode.Argv,
                command: 'probe',
                argv: [action],
                cwd: 'nested',
                environment: [{ name: 'APP_MODE', value: 'fixture' }],
                stdin: initial,
                timeoutMs,
            },
            executionDeadlineMs: now + BigInt(timeoutMs),
            dimensions: null,
        };
        const base: ExecutionPermit = signed.permit(signed.admission());
        const { signature: _signature, ...body }: ExecutionPermit = base;
        const request: ExecutionRequest = signed.request(launch, rule, base.sequence);
        const requestHash: string = ExecutionProof.requestHash(request);
        const unsigned: Omit<ExecutionPermit, 'signature'> = {
            ...body,
            request,
            requestHash,
            admissionHash: ConnectorAuthorizationProof.execution(
                requestHash,
                base.lane,
                base.authorization,
            ),
            issuedAtMs: now,
            expiresAtMs: now + BigInt(Math.min(timeoutMs, 1000)),
            executionDeadlineMs: launch.executionDeadlineMs,
        };
        const permit: ExecutionPermit = {
            ...unsigned,
            signature: signed.peer.authority.sign(
                SignaturePurpose.OperationExecutionPermit,
                ExecutionProof.permit(unsigned),
            ),
        };
        const incarnation: string = randomBytes(32).toString('hex');
        await journal.prepareFresh(
            { permit, rule, launch, incarnation },
            signed.session,
            clock.now(),
        );
        const invocation: ExecutionPipeInvocation = await native.launch(
            action,
            initial,
            ExecutionWorkspaceAccess.ReadWrite,
            timeoutMs,
            stop.signal,
            { maximumInputBytes: rule.maximumInputBytes, maximumControls: rule.maximumControls },
            incarnation,
            launch.executionDeadlineMs,
        );
        resources.defer(async (): Promise<void> => {
            stop.abort();
            await invocation.joined;
        });
        const runtime: ExecutionInteractiveRuntime = await ExecutionInteractiveRuntime.create({
            identity: signed.peer.identity,
            permit,
            rule,
            launch,
            incarnation: invocation.incarnation,
            native: invocation.pipe,
            journal,
            nowMs: (): bigint => clock.now(),
        });
        return new ExecutionInteractiveRuntimeFixture(
            resources.move(),
            signed,
            native,
            journal,
            invocation,
            runtime,
            stop,
            permit,
            clock,
        );
    }

    public data(
        bytes: Buffer = Buffer.from(this.runtime.admission.launch.invocation.stdin),
        sequence: bigint = 0n,
        prior: ExecutionInputCursor | null = null,
    ): ExecutionInputPermit {
        return this.#current(this.signed.input(this.runtime.admission, bytes, sequence, prior));
    }

    public end(sequence: bigint, prior: ExecutionInputCursor): ExecutionInputPermit {
        const base: ExecutionInputPermit = this.signed.input(
            this.runtime.admission,
            Buffer.from('unused'),
            sequence,
            prior,
        );
        const input: typeof base.input = {
            ...base.input,
            control: { kind: ExecutionInputKind.End, offset: prior.acceptedOffset },
        };
        const body: ExecutionInputPermitBody = {
            ...ExecutionInputPermitCodec.unsigned(base),
            input,
            inputHash: Proof.inputHash(input),
        };
        return this.#current({
            ...body,
            signature: this.signed.peer.authority.sign(
                SignaturePurpose.OperationExecutionInputPermit,
                Proof.permit(body, this.runtime.admission.ready),
            ),
        });
    }

    #current(value: ExecutionInputPermit): ExecutionInputPermit {
        const now: bigint = this.clock.now();
        const body: ExecutionInputPermitBody = {
            ...ExecutionInputPermitCodec.unsigned(value),
            issuedAtMs: now,
            expiresAtMs:
                now + 1000n < value.executionDeadlineMs ? now + 1000n : value.executionDeadlineMs,
        };
        return {
            ...body,
            signature: this.signed.peer.authority.sign(
                SignaturePurpose.OperationExecutionInputPermit,
                Proof.permit(body, this.runtime.admission.ready),
            ),
        };
    }

    public async [Symbol.asyncDispose](): Promise<void> {
        await this.#resources[Symbol.asyncDispose]();
    }
}
