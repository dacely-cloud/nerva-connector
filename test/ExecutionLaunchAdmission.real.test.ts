// SPDX-FileCopyrightText: 2026 Nerva contributors
// SPDX-License-Identifier: LicenseRef-Proprietary

import { randomBytes } from 'node:crypto';
import { setTimeout as delay } from 'node:timers/promises';
import { readdir } from 'node:fs/promises';
import { expect, it, vi, type MockInstance } from 'vitest';
import { ExecutionInteractiveOwnershipFixture } from './support/ExecutionInteractiveOwnershipFixture.js';
import { ExecutionInputJournalOwner } from '../src/execution/ExecutionInputJournalOwner.js';
import {
    ExecutionInputJournalPhase,
    type ExecutionInputJournalPreparedState,
} from '../src/execution/ExecutionInputJournalTypes.js';
import { ExecutionNativePipeHandle } from '../src/execution/ExecutionNativePipeHandle.js';
import { ExecutionFixture } from './support/ExecutionFixture.js';
import { ExecutionIdentity } from './support/ExecutionIdentity.js';
import { setup } from './support/ExecutionSetup.js';
import { ExecutionConfiguration } from '../src/execution/ExecutionConfiguration.js';
import { ExecutionPolicy } from '../src/execution/ExecutionPolicy.js';
import { ExecutionClient } from '../src/execution/ExecutionClient.js';
import { ExecutionJournalInstallation } from '../src/execution/ExecutionJournalInstallation.js';
import { ExecutionEffectCapture } from '../src/execution/ExecutionEffectCapture.js';
import { ExecutionCgroup } from '../src/execution/ExecutionCgroup.js';
import type { ExecutionClientSettings } from '../src/execution/ExecutionClientSettings.js';
import type { ExecutionPermit, ExecutionCompletion } from '../src/execution/ExecutionJobs.js';
import { ExecutionTermination } from '../src/execution/ExecutionTypes.js';
import { ConnectorClientSession } from '../src/runtime/ConnectorClientSession.js';
import { ConnectorDeviceCodec } from 'nerva-connector-protocol/protocol/ConnectorDeviceCodec.js';
import type {
    ConnectorDeviceChallenge,
    ConnectorDeviceLease,
    ConnectorDeviceProof,
} from 'nerva-connector-protocol/protocol/ConnectorDevice.js';
import { ExecutionProof } from '../src/execution/ExecutionProof.js';
import { SignaturePurpose } from 'nerva-connector-protocol/identity/IdentityFormat.js';
import { ConnectorOperationSchema } from 'nerva-connector-protocol/protocol/ConnectorOperationSchema.js';

/** A real same-session replacement preserves normal client/server transcript verification. */
function renew(authority: ExecutionIdentity, session: ConnectorClientSession): void {
    const now: bigint = BigInt(Date.now());
    const hello: ReturnType<ConnectorClientSession['begin']> = session.begin(now);
    const body: Omit<ConnectorDeviceChallenge, 'signature'> = {
        operationSchema: ConnectorOperationSchema.ExplicitAdmission,
        authorityId: hello.authorityId,
        environmentId: hello.environmentId,
        enrollmentId: hello.enrollmentId,
        slot: hello.slot,
        publicKey: hello.publicKey,
        clientNonce: hello.nonce,
        helloSha256: ExecutionProof.digest(ConnectorDeviceCodec.helloCommitment(hello)),
        challengeId: randomBytes(32).toString('base64url'),
        leaseId: randomBytes(32).toString('base64url'),
        edgeClientId: 'edge',
        edgeWorkloadThumbprint: randomBytes(32).toString('base64url'),
        issuedAtMs: now,
        expiresAtMs: now + 30000n,
    };
    const challenge: ConnectorDeviceChallenge = {
        ...body,
        signature: authority.authority.sign(
            SignaturePurpose.ServerChallenge,
            Buffer.from(ConnectorDeviceCodec.challengePayload(body)),
        ),
    };
    const proof: ConnectorDeviceProof = session.prove(challenge, now);
    const confirmation: Omit<ConnectorDeviceLease, 'signature'> = {
        ...challenge,
        challengeSha256: ExecutionProof.digest(ConnectorDeviceCodec.challengeCommitment(challenge)),
        authenticationSha256: ExecutionProof.digest(ConnectorDeviceCodec.proofCommitment(proof)),
    };
    session.confirm(
        {
            ...confirmation,
            signature: authority.authority.sign(
                SignaturePurpose.ServerConfirmation,
                Buffer.from(ConnectorDeviceCodec.leasePayload(confirmation)),
            ),
        },
        now,
    );
}

/** These faults occur after Started, while the actual cached physical capture is awaited. */
enum CaptureFault {
    Expired = 'expired',
    Renewed = 'renewed',
    Disposed = 'disposed',
}
const helper: string | undefined = process.env['NERVA_CONNECTOR_EXEC_HELPER'];

it.skipIf(helper === undefined).each(Object.values(CaptureFault))(
    'an actual command cannot create or bind a native group after delayed capture changes start authority (%s)',
    async (fault: CaptureFault): Promise<void> => {
        if (helper === undefined) {
            throw new Error('Explicit unused candidate required');
        }
        await using fixture: ExecutionFixture = await ExecutionFixture.create(helper);
        const settings: ExecutionClientSettings = await setup(fixture);
        using authority: ExecutionIdentity = new ExecutionIdentity(fixture.directory, settings);
        await ExecutionJournalInstallation.initialize(authority.identity, settings);
        await using policy: ExecutionPolicy = await ExecutionConfiguration.loadPolicy(
            authority.identity,
            settings,
        );
        await using client: ExecutionClient = await ExecutionClient.load(
            authority.identity,
            settings,
            policy,
        );
        const lease: ConnectorDeviceLease = authority.lease();
        const session: ConnectorClientSession = authority.session(lease);
        const permit: ExecutionPermit = authority.permit(client.profile, lease);
        let captures: number = 0;
        let capture: MockInstance<ExecutionEffectCapture['context']> = vi.spyOn(
            ExecutionEffectCapture.prototype,
            'context',
        );
        const group: MockInstance<typeof ExecutionCgroup.create> = vi.spyOn(
            ExecutionCgroup,
            'create',
        );
        async function delayed(
            this: ExecutionEffectCapture,
            ...args: Parameters<ExecutionEffectCapture['context']>
        ): Promise<Awaited<ReturnType<ExecutionEffectCapture['context']>>> {
            capture.mockRestore();
            let result: Awaited<ReturnType<ExecutionEffectCapture['context']>>;
            try {
                result = await this.context(...args);
            } finally {
                capture = vi
                    .spyOn(ExecutionEffectCapture.prototype, 'context')
                    .mockImplementation(delayed);
            }
            if (++captures === 2) {
                if (fault === CaptureFault.Expired) {
                    await delay(Number(permit.expiresAtMs - BigInt(Date.now()) + 20n));
                } else if (fault === CaptureFault.Renewed) {
                    renew(authority, session);
                } else {
                    session[Symbol.dispose]();
                }
            }
            return result;
        }
        capture.mockImplementation(delayed);
        try {
            const completion: ExecutionCompletion = await client.execute(permit, session);
            expect(completion.response.termination).toBe(ExecutionTermination.Indeterminate);
            expect(completion.response.exitCode).toBeNull();
            expect(group).not.toHaveBeenCalled();
            expect(
                (await readdir(fixture.delegation)).filter((name: string): boolean =>
                    name.startsWith('exec-'),
                ),
            ).toEqual([]);
        } finally {
            capture.mockRestore();
            group.mockRestore();
        }
    },
);

it.skipIf(helper === undefined)(
    'a delayed durable Prepared write cannot bind or launch a native original after its captured start window, and the unused handle joins cleanup',
    async (): Promise<void> => {
        if (helper === undefined) {
            throw new Error('Explicit unused candidate required');
        }
        const prepared: ExecutionInputJournalPreparedState[] = [];
        let prepare: MockInstance<ExecutionInputJournalOwner['prepareFresh']> = vi.spyOn(
            ExecutionInputJournalOwner.prototype,
            'prepareFresh',
        );
        const group: MockInstance<typeof ExecutionCgroup.create> = vi.spyOn(
            ExecutionCgroup,
            'create',
        );
        const close: MockInstance<ExecutionNativePipeHandle['close']> = vi.spyOn(
            ExecutionNativePipeHandle.prototype,
            'close',
        );
        async function delayed(
            this: ExecutionInputJournalOwner,
            ...args: Parameters<ExecutionInputJournalOwner['prepareFresh']>
        ): Promise<ExecutionInputJournalPreparedState> {
            prepare.mockRestore();
            let state: ExecutionInputJournalPreparedState;
            try {
                state = await this.prepareFresh(...args);
            } finally {
                prepare = vi
                    .spyOn(ExecutionInputJournalOwner.prototype, 'prepareFresh')
                    .mockImplementation(delayed);
            }
            prepared.push(state);
            await delay(Number(state.preparation.permit.expiresAtMs - BigInt(Date.now()) + 20n));
            return state;
        }
        prepare.mockImplementation(delayed);
        try {
            await expect(ExecutionInteractiveOwnershipFixture.create(helper)).rejects.toThrow(
                'launch authority expired',
            );
            expect(prepared).toHaveLength(1);
            expect(prepared[0]?.phase).toBe(ExecutionInputJournalPhase.Prepared);
            expect(group).not.toHaveBeenCalled();
            expect(close).toHaveBeenCalled();
        } finally {
            prepare.mockRestore();
            group.mockRestore();
            close.mockRestore();
        }
    },
);
