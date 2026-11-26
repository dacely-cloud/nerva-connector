// SPDX-FileCopyrightText: 2026 Dacely <business@dacely.com>
// SPDX-License-Identifier: LicenseRef-Proprietary

import { randomBytes } from 'node:crypto';
import { expect, it, vi, type MockInstance } from 'vitest';
import { ConnectorHostObservationFixture as Fixture } from './support/ConnectorHostObservationFixture.js';
import { ConnectorClientHost } from '../src/runtime/ConnectorClientHost.js';
import { ConnectorHostObservationDelivery as Delivery } from '../src/runtime/ConnectorHostObservationDelivery.js';
import { ConnectorHostObservationCapabilityProof } from '../src/runtime/ConnectorHostObservationCapabilityProof.js';
import { ConnectorHostObservationCapabilityTranscript } from 'nerva-connector-protocol/protocol/ConnectorHostObservationCapabilityTranscript.js';
import { ConnectorHostObservationTranscript as Transcript } from 'nerva-connector-protocol/protocol/ConnectorHostObservationTranscript.js';
import { ConnectorHostProof } from '../src/runtime/ConnectorHostProof.js';
import { ConnectorHostObservedStart } from 'nerva-connector-protocol/protocol/ConnectorHostObservationProtocol.js';
import type { ConnectorHostObservationActivation } from 'nerva-connector-protocol/protocol/ConnectorHostObservationCapability.js';
import type {
    ConnectorHostObservationReady as Ready,
    ConnectorHostObservationPermit as Permit,
} from 'nerva-connector-protocol/protocol/ConnectorHostObservation.js';
import type { ConnectorHostObservationConnection as Connection } from '../src/runtime/ConnectorHostObservationOwners.js';
import { SignaturePurpose } from 'nerva-connector-protocol/identity/IdentityFormat.js';
import { HostProcess } from '../src/host/HostProcess.js';
import { HostTerminal } from '../src/host/HostTerminal.js';
import { HostWorkspace } from '../src/host/HostWorkspace.js';

/** A new authority-authenticated companion belongs to the actual replacement workspace, never a guessed old runtime. */
function activate(
    fixture: Fixture,
    replacement: ConnectorClientHost,
    connection: Connection,
): string {
    const capability: ReturnType<ConnectorClientHost['observationCapability']> =
        replacement.observationCapability(connection.companionNonce, connection);
    const body: Omit<ConnectorHostObservationActivation, 'signature'> = {
        authorityId: fixture.grant.authorityId,
        enrollmentId: fixture.grant.enrollmentId,
        leaseId: connection.leaseId,
        journalId: fixture.grant.journalId,
        companionNonce: connection.companionNonce,
        runtimeId: capability.runtimeId,
        publicationSha256: ConnectorHostObservationCapabilityProof.publicationSha256(
            capability.publication,
        ),
        issuedAtMs: connection.nowMs,
        expiresAtMs: connection.expiresAtMs,
    };
    const activation: ConnectorHostObservationActivation = {
        ...body,
        signature: fixture.base.peer.authority.sign(
            SignaturePurpose.HostObservationPermit,
            Buffer.from(ConnectorHostObservationCapabilityTranscript.activation(body)),
        ),
    };
    replacement.activateObservation(
        JSON.parse(Transcript.encode(activation)),
        connection.companionNonce,
        connection,
    );
    return capability.runtimeId;
}

/** Both cases retain a real completed start receipt; only the second has emitted a signed native Ready before replacement. */
async function replaced(afterReady: boolean): Promise<void> {
    await using fixture: Fixture = await Fixture.create();
    let ready: Ready | null = null;
    if (afterReady) {
        const received: Ready[] = [];
        await using delivery: Delivery = new Delivery(fixture.host, fixture.connection, {
            ready: (value: Ready): void => {
                received.push(value);
            },
            changed: (): void => undefined,
            failed: (): void => {
                throw new Error('Fixture metadata delivery failed');
            },
        });
        delivery.permit(JSON.parse(Transcript.encode(fixture.permit())));
        await vi.waitFor((): void => expect(received).toHaveLength(1), {
            timeout: 5000,
            interval: 10,
        });
        ready = received[0] ?? null;
        if (ready === null) {
            throw new Error('Expected actual signed first Ready');
        }
        expect(
            ConnectorHostProof.verify(
                fixture.base.identity.publicKey,
                SignaturePurpose.HostObservationReady,
                Buffer.from(Transcript.ready(ready)),
                ready.signature,
            ),
        ).toBe(true);
    }
    const oldRuntime: string =
        ready?.runtimeId ??
        fixture.host.observationCapability(fixture.connection.companionNonce, fixture.connection)
            .runtimeId;
    await fixture.host[Symbol.asyncDispose]();
    const process: MockInstance<typeof HostProcess.create> = vi.spyOn(HostProcess, 'create');
    const terminal: MockInstance<typeof HostTerminal.create> = vi.spyOn(HostTerminal, 'create');
    const lookup: MockInstance<HostWorkspace['observe']> = vi.spyOn(
        HostWorkspace.prototype,
        'observe',
    );
    try {
        const host: ConnectorClientHost | null = await ConnectorClientHost.load(
            fixture.base.identity,
            ConnectorHostObservedStart.Protocol,
        );
        if (host === null) {
            throw new Error('Expected unchanged explicit local grant');
        }
        await using replacement: ConnectorClientHost = host;
        expect(replacement.journal.snapshot.receipt?.jobId).toBe(fixture.original.jobId);
        const current: Connection = {
            ...fixture.connection,
            leaseId: randomBytes(32).toString('base64url'),
            companionNonce: randomBytes(32).toString('base64url'),
            nowMs: BigInt(Date.now()),
        };
        expect(activate(fixture, replacement, current)).not.toBe(oldRuntime);
        const permit: Permit = fixture.permit({
            leaseId: current.leaseId,
            companionNonce: current.companionNonce,
            generation: ready === null ? 1n : 2n,
            runtimeId: ready?.runtimeId ?? null,
            instanceSha256: ready?.instanceSha256 ?? null,
        });
        expect(permit.origin.processId).toBe(fixture.processId);
        expect(permit.origin.startResponseHash).toBe(fixture.completion.responseHash);
        expect(
            ConnectorHostProof.verify(
                fixture.base.peer.authority.publicKey,
                SignaturePurpose.HostObservationPermit,
                Buffer.from(Transcript.permit(permit)),
                permit.signature,
            ),
        ).toBe(true);
        await expect(
            replacement.observe(JSON.parse(Transcript.encode(permit)), current),
        ).rejects.toThrow('origin');
        expect(process).not.toHaveBeenCalled();
        expect(terminal).not.toHaveBeenCalled();
        expect(lookup).not.toHaveBeenCalled();
        expect(replacement.journal.snapshot.receipt?.jobId).toBe(fixture.original.jobId);
    } finally {
        process.mockRestore();
        terminal.mockRestore();
        lookup.mockRestore();
    }
}

it.skipIf(process.platform !== 'linux')(
    'a sealed start before first Ready cannot attach its old PID after an authenticated native runtime replacement',
    async (): Promise<void> => {
        await replaced(false);
    },
);

it.skipIf(process.platform !== 'linux')(
    'a previously signed first Ready cannot repin its old native instance after authenticated runtime replacement',
    async (): Promise<void> => {
        await replaced(true);
    },
);
