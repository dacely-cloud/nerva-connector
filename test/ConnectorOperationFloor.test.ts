// SPDX-FileCopyrightText: 2026 Dacely <business@dacely.com>
// SPDX-License-Identifier: LicenseRef-Proprietary

import { expect, it } from 'vitest';
import { SignaturePurpose } from 'nerva-connector-protocol/identity/IdentityFormat.js';
import { ConnectorOperationSchema } from 'nerva-connector-protocol/protocol/ConnectorOperationSchema.js';
import { ConnectorDeviceCodec } from 'nerva-connector-protocol/protocol/ConnectorDeviceCodec.js';
import type {
    ConnectorDeviceHello,
    ConnectorDeviceChallenge,
    ConnectorDeviceLease,
    ConnectorDeviceProof,
} from 'nerva-connector-protocol/protocol/ConnectorDevice.js';
import { ConnectorClientSession } from '../src/runtime/ConnectorClientSession.js';
import { Boundary } from 'nerva-connector-protocol/protocol/Boundary.js';
import { ConnectorSessionFixture } from './support/ConnectorSessionFixture.js';

it('the real hello, challenge, client proof and confirmation authenticate one explicit operation floor before a usable session exists', (): void => {
    using fixture: ConnectorSessionFixture = new ConnectorSessionFixture();
    using session: ConnectorClientSession = new ConnectorClientSession(fixture.identity);
    const hello: ConnectorDeviceHello = session.begin(fixture.now);
    expect(hello.operationSchema).toBe(ConnectorOperationSchema.ExplicitAdmission);
    expect((): ConnectorDeviceLease =>
        ConnectorClientSession.current(session, fixture.now),
    ).toThrow();
    const challenge: ConnectorDeviceChallenge = fixture.challenge(hello);
    const proof: ConnectorDeviceProof = session.prove(challenge, fixture.now);
    expect((): ConnectorDeviceLease =>
        ConnectorClientSession.current(session, fixture.now),
    ).toThrow();
    const lease: ConnectorDeviceLease = session.confirm(
        fixture.confirmation(challenge, proof),
        fixture.now,
    );
    expect(lease.operationSchema).toBe(ConnectorOperationSchema.ExplicitAdmission);
    expect(ConnectorClientSession.current(session, fixture.now)).toBe(lease);
});

it('normal hello, challenge and lease codecs refuse omitted or foreign floors without an older-format interpretation', (): void => {
    using fixture: ConnectorSessionFixture = new ConnectorSessionFixture();
    using session: ConnectorClientSession = new ConnectorClientSession(fixture.identity);
    const hello: ConnectorDeviceHello = session.begin(fixture.now);
    const challenge: ConnectorDeviceChallenge = fixture.challenge(hello);
    const proof: ConnectorDeviceProof = session.prove(challenge, fixture.now);
    const lease: ConnectorDeviceLease = fixture.confirmation(challenge, proof);
    const originals: readonly [
        ConnectorDeviceHello | ConnectorDeviceChallenge | ConnectorDeviceLease,
        (raw: unknown) => ConnectorDeviceHello | ConnectorDeviceChallenge | ConnectorDeviceLease,
    ][] = [
        [hello, (raw: unknown): ConnectorDeviceHello => ConnectorDeviceCodec.hello(raw)],
        [
            challenge,
            (raw: unknown): ConnectorDeviceChallenge => ConnectorDeviceCodec.challenge(raw),
        ],
        [lease, (raw: unknown): ConnectorDeviceLease => ConnectorDeviceCodec.lease(raw)],
    ];
    for (const [value, decode] of originals) {
        const parsed: unknown = JSON.parse(ConnectorDeviceCodec.encode(value));
        const raw: Readonly<Record<string, unknown>> = Boundary.record(parsed, Object.keys(value));
        const missing: Record<string, unknown> = { ...raw };
        Reflect.deleteProperty(missing, 'operationSchema');
        expect((): ConnectorDeviceHello | ConnectorDeviceChallenge | ConnectorDeviceLease =>
            decode(missing),
        ).toThrow('operation schema');
        expect((): ConnectorDeviceHello | ConnectorDeviceChallenge | ConnectorDeviceLease =>
            decode({ ...raw, operationSchema: 'legacy' }),
        ).toThrow('operation schema');
    }
});

it('an older signed challenge cannot become current by adding an unsigned operation floor', (): void => {
    using fixture: ConnectorSessionFixture = new ConnectorSessionFixture();
    using session: ConnectorClientSession = new ConnectorClientSession(fixture.identity);
    const hello: ConnectorDeviceHello = session.begin(fixture.now);
    const challenge: ConnectorDeviceChallenge = fixture.challenge(hello);
    const parsed: unknown = JSON.parse(ConnectorDeviceCodec.challengePayload(challenge));
    const transcript: readonly unknown[] = Boundary.array(parsed, 32);
    expect(transcript[1]).toBe(ConnectorOperationSchema.ExplicitAdmission);
    const withoutFloor: string = JSON.stringify(
        transcript.filter((_field: unknown, index: number): boolean => index !== 1),
    );
    const signature: string = fixture.authority.sign(
        SignaturePurpose.ServerChallenge,
        Buffer.from(withoutFloor),
    );
    expect((): ConnectorDeviceProof =>
        session.prove({ ...challenge, signature }, fixture.now),
    ).toThrow('challenge rejected');
    expect((): ConnectorDeviceLease =>
        ConnectorClientSession.current(session, fixture.now),
    ).toThrow();
});
