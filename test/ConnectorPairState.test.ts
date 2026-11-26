// SPDX-FileCopyrightText: 2026 Dacely <business@dacely.com>
// SPDX-License-Identifier: LicenseRef-Proprietary

import { createHash } from 'node:crypto';
import { SigningKey } from '../src/identity/SigningKey.js';
import { mkdtemp, readFile, writeFile, rm } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { expect, it, vi, type MockInstance } from 'vitest';
import {
    ConnectorDeviceKey,
    type ConnectorDeviceIdentity,
} from '../src/runtime/ConnectorDeviceKey.js';
import { ConnectorPairState, ConnectorPairPhase } from '../src/runtime/ConnectorPairState.js';
import {
    ConnectorLinkPhase,
    type ConnectorLinkIssued,
    type ConnectorLinkStatus,
} from 'nerva-connector-protocol/protocol/ConnectorLink.js';
import { ConnectorReleaseFixture } from './support/ConnectorReleaseFixture.js';
import { ConnectorReleaseInstallation } from '../src/install/ConnectorReleaseInstallation.js';
import {
    ConnectorPairClient,
    ConnectorPairIntent,
    type ConnectorPairEvent,
} from '../src/runtime/ConnectorPairClient.js';
import {
    ConnectorStartupStage,
    type ConnectorStartupProgress,
} from '../src/runtime/ConnectorStartup.js';

/** Every key and state file belongs to a new private fixture directory and is removed on every test exit. */
class PairStateFixture implements AsyncDisposable {
    public readonly digest: string = 'a'.repeat(64);
    private constructor(
        public readonly directory: string,
        public readonly identity: ConnectorDeviceIdentity,
    ) {}
    public static async create(): Promise<PairStateFixture> {
        const directory: string = await mkdtemp(join(homedir(), '.nerva-pair-state-'));
        try {
            const path: string = join(directory, 'device-key.json');
            await ConnectorDeviceKey.initialize(path);
            return new PairStateFixture(directory, await ConnectorDeviceKey.load(path));
        } catch (caught: unknown) {
            await rm(directory, { recursive: true, force: true });
            throw caught;
        }
    }
    public async open(): Promise<ConnectorPairState> {
        return await ConnectorPairState.open(this.directory, this.identity, this.digest);
    }
    public async [Symbol.asyncDispose](): Promise<void> {
        this.identity.key[Symbol.dispose]();
        await rm(this.directory, { recursive: true, force: true });
    }
}

it('signed pairing state preserves the original nonce and forbids configuration, device and lifecycle rewinds', async (): Promise<void> => {
    await using fixture: PairStateFixture = await PairStateFixture.create();
    let original: string;
    {
        await using state: ConnectorPairState = await fixture.open();
        original = state.snapshot.requestId;
        const issued: ConnectorLinkIssued = {
            linkId: createHash('sha256').update(Buffer.from(original, 'base64url')).digest('hex'),
            code: 'ABCD-EFGH',
            expiresAtMs: 601000n,
            pollIntervalMs: 5000,
        };
        await state.write({ ...state.snapshot, issued });
        await state.write({
            ...state.snapshot,
            phase: ConnectorPairPhase.Registered,
            enrollmentId: 'conn_' + 'b'.repeat(64),
            environmentId: 'env_connector_' + 'b'.repeat(64),
        });
        await state.write({ ...state.snapshot, phase: ConnectorPairPhase.Configured });
        await expect(
            state.write({ ...state.snapshot, phase: ConnectorPairPhase.Registered }),
        ).rejects.toThrow('cannot be rewound');
        await expect(state.write({ ...state.snapshot, requestId: 'A'.repeat(43) })).rejects.toThrow(
            'identity changed',
        );
    }
    await using restored: ConnectorPairState = await fixture.open();
    expect(restored.snapshot.requestId).toBe(original);
    expect(restored.snapshot.phase).toBe(ConnectorPairPhase.Configured);
    expect(Object.isFrozen(restored.snapshot)).toBe(true);
    expect(Object.isFrozen(restored.snapshot.issued)).toBe(true);
});

it('tampered or differently configured local history is rejected without replacing it', async (): Promise<void> => {
    await using fixture: PairStateFixture = await PairStateFixture.create();
    let original: string;
    {
        await using state: ConnectorPairState = await fixture.open();
        original = state.snapshot.requestId;
    }
    const path: string = join(fixture.directory, 'pairing-state');
    const before: Buffer = await readFile(path);
    await expect(
        ConnectorPairState.open(fixture.directory, fixture.identity, 'b'.repeat(64)),
    ).rejects.toThrow('does not match');
    expect(await readFile(path)).toEqual(before);
    const tampered: string = before.toString('utf8').replace(original, 'A'.repeat(43));
    await writeFile(path, tampered, { mode: 0o600 });
    await expect(fixture.open()).rejects.toThrow('does not match');
    expect(await readFile(path, 'utf8')).toBe(tampered);
});

it('directory ownership is exclusive even if a competing initializer supplies a different device key', async (): Promise<void> => {
    await using fixture: PairStateFixture = await PairStateFixture.create();
    await using state: ConnectorPairState = await fixture.open();
    using key: SigningKey = SigningKey.generate();
    await expect(
        ConnectorPairState.open(
            fixture.directory,
            {
                key,
                publicKey: key.publicKey,
            },
            fixture.digest,
        ),
    ).rejects.toThrow();
    expect(
        (await readFile(join(fixture.directory, 'pairing-state'), 'utf8')).includes(
            state.snapshot.requestId,
        ),
    ).toBe(true);
});

it('a missing pairing history cannot be recreated over an already published runtime configuration', async (): Promise<void> => {
    await using fixture: PairStateFixture = await PairStateFixture.create();
    {
        await using state: ConnectorPairState = await fixture.open();
        await state.write({
            ...state.snapshot,
            phase: ConnectorPairPhase.Registered,
            enrollmentId: 'conn_' + 'b'.repeat(64),
            environmentId: 'env_connector_' + 'b'.repeat(64),
        });
        await state.write({ ...state.snapshot, phase: ConnectorPairPhase.Configured });
        await state.publishConfiguration(Buffer.from('{"original":"configuration"}'));
    }
    await rm(join(fixture.directory, 'pairing-state'));
    await expect(fixture.open()).rejects.toThrow('lost its pairing history');
    await expect(readFile(join(fixture.directory, 'pairing-state'))).rejects.toThrow();
    expect(await readFile(join(fixture.directory, 'device.json'), 'utf8')).toBe(
        '{"original":"configuration"}',
    );
});

it('explicit renewal requires confirmed expiry of the same unbound attempt and retains a signed constant-size predecessor commitment', async (): Promise<void> => {
    await using fixture: PairStateFixture = await PairStateFixture.create();
    let replacement: string;
    {
        await using state: ConnectorPairState = await fixture.open();
        const requestId: string = state.snapshot.requestId;
        const status: ConnectorLinkStatus = {
            linkId: createHash('sha256').update(Buffer.from(requestId, 'base64url')).digest('hex'),
            publicKey: fixture.identity.publicKey,
            phase: ConnectorLinkPhase.Expired,
            enrollment: null,
            expiresAtMs: 601000n,
            pollIntervalMs: 5000,
        };
        await expect(state.renewExpired(status)).rejects.toThrow('confirmed expired');
        await state.write({ ...state.snapshot, phase: ConnectorPairPhase.Expired });
        await expect(
            state.renewExpired({ ...status, phase: ConnectorLinkPhase.Pending }),
        ).rejects.toThrow('confirmed expired');
        await expect(state.renewExpired({ ...status, linkId: 'b'.repeat(64) })).rejects.toThrow(
            'confirmed expired',
        );
        const before: Buffer = await readFile(join(fixture.directory, 'pairing-state'));
        const envelope: unknown = JSON.parse(before.toString('utf8'));
        if (typeof envelope !== 'object' || envelope === null || !('state' in envelope)) {
            throw new Error('Signed fixture envelope missing');
        }
        const commitment: string = createHash('sha256')
            .update(JSON.stringify(envelope.state))
            .digest('hex');
        await state.renewExpired(status);
        replacement = state.snapshot.requestId;
        expect(replacement).not.toBe(requestId);
        expect(state.snapshot.publicKey).toBe(fixture.identity.publicKey);
        expect(state.snapshot.phase).toBe(ConnectorPairPhase.Authorizing);
        expect(state.snapshot.issued).toBeNull();
        expect(state.snapshot.renewal).toEqual({ revision: 1n, previousStateSha256: commitment });
        expect(Object.isFrozen(state.snapshot.renewal)).toBe(true);
        await expect(state.write({ ...state.snapshot, renewal: null })).rejects.toThrow(
            'identity changed',
        );
        await expect(state.renewExpired(status)).rejects.toThrow('confirmed expired');
    }
    await using restored: ConnectorPairState = await fixture.open();
    expect(restored.snapshot.requestId).toBe(replacement);
    expect(restored.snapshot.renewal?.revision).toBe(1n);
    expect(restored.snapshot.enrollmentId).toBeNull();
});

it.each([ConnectorPairPhase.Registered, ConnectorPairPhase.Configured, ConnectorPairPhase.Revoked])(
    'renewal cannot discard a %s account binding or rewrite its retained configuration',
    async (phase: ConnectorPairPhase): Promise<void> => {
        await using fixture: PairStateFixture = await PairStateFixture.create();
        await using state: ConnectorPairState = await fixture.open();
        await state.write({
            ...state.snapshot,
            phase: ConnectorPairPhase.Registered,
            enrollmentId: 'conn_' + 'b'.repeat(64),
            environmentId: 'env_connector_' + 'b'.repeat(64),
        });
        if (phase !== ConnectorPairPhase.Registered) {
            await state.write({ ...state.snapshot, phase });
        }
        const before: Buffer = await readFile(join(fixture.directory, 'pairing-state'));
        await expect(
            state.renewExpired({
                linkId: createHash('sha256')
                    .update(Buffer.from(state.snapshot.requestId, 'base64url'))
                    .digest('hex'),
                publicKey: fixture.identity.publicKey,
                phase: ConnectorLinkPhase.Expired,
                enrollment: null,
                expiresAtMs: 601000n,
                pollIntervalMs: 5000,
            }),
        ).rejects.toThrow('confirmed expired');
        expect(await readFile(join(fixture.directory, 'pairing-state'))).toEqual(before);
    },
);

/** Both observations must recover one atomic original, including a durable commit whose reply was lost. */
enum RenewalCommitFailure {
    Before = 'before',
    After = 'after',
}

it('explicit renewal refuses missing original history without initializing or replacing a device key', async (): Promise<void> => {
    await using fixture: ConnectorReleaseFixture = await ConnectorReleaseFixture.create(true);
    const installed: Awaited<ReturnType<typeof ConnectorReleaseInstallation.install>> =
        await ConnectorReleaseInstallation.install(
            join(fixture.directory, 'installation.json'),
            new AbortController().signal,
        );
    const keyFile: string = join(fixture.directory, 'installed/state/device-key.json');
    const key: Buffer = await readFile(keyFile);
    const events: ConnectorPairEvent[] = [];
    const startup: ConnectorStartupStage[] = [];
    await expect(
        ConnectorPairClient.run(
            installed.pairingFile,
            new AbortController().signal,
            (event: ConnectorPairEvent): void => {
                events.push(event);
            },
            ConnectorPairIntent.RenewExpired,
            (progress: ConnectorStartupProgress): void => {
                startup.push(progress.stage);
            },
        ),
    ).rejects.toThrow();
    expect(events).toEqual([]);
    expect(startup).toEqual([ConnectorStartupStage.Configuration, ConnectorStartupStage.Identity]);
    expect(await readFile(keyFile)).toEqual(key);
    await rm(keyFile);
    await expect(
        ConnectorPairClient.run(
            installed.pairingFile,
            new AbortController().signal,
            (event: ConnectorPairEvent): void => {
                events.push(event);
            },
            ConnectorPairIntent.RenewExpired,
        ),
    ).rejects.toThrow();
    await expect(readFile(keyFile)).rejects.toThrow();
    await expect(
        readFile(join(fixture.directory, 'installed/state/pairing-state')),
    ).rejects.toThrow();
});

it.each(Object.values(RenewalCommitFailure))(
    'renewal recovery preserves one attempt after a %s-commit publication failure',
    async (failure: RenewalCommitFailure): Promise<void> => {
        await using fixture: PairStateFixture = await PairStateFixture.create();
        let original: string;
        let status: ConnectorLinkStatus;
        {
            await using state: ConnectorPairState = await fixture.open();
            original = state.snapshot.requestId;
            await state.write({ ...state.snapshot, phase: ConnectorPairPhase.Expired });
            status = {
                linkId: createHash('sha256')
                    .update(Buffer.from(original, 'base64url'))
                    .digest('hex'),
                publicKey: fixture.identity.publicKey,
                phase: ConnectorLinkPhase.Expired,
                enrollment: null,
                expiresAtMs: 601000n,
                pollIntervalMs: 5000,
            };
            const publish: typeof state.directory.write = state.directory.write.bind(
                state.directory,
            );
            const observed: MockInstance<typeof state.directory.write> = vi.spyOn(
                state.directory,
                'write',
            );
            try {
                observed.mockImplementationOnce(
                    async (
                        name: string,
                        bytes: Buffer,
                        maximum: number,
                        initialize: boolean,
                    ): Promise<void> => {
                        if (failure === RenewalCommitFailure.After) {
                            await publish(name, bytes, maximum, initialize);
                        }
                        throw new Error('Injected renewal publication observation loss');
                    },
                );
                await expect(state.renewExpired(status)).rejects.toThrow('observation loss');
            } finally {
                observed.mockRestore();
            }
        }
        await using recovered: ConnectorPairState = await fixture.open();
        if (failure === RenewalCommitFailure.Before) {
            expect(recovered.snapshot.requestId).toBe(original);
            expect(recovered.snapshot.phase).toBe(ConnectorPairPhase.Expired);
            await recovered.renewExpired(status);
        }
        expect(recovered.snapshot.requestId).not.toBe(original);
        expect(recovered.snapshot.phase).toBe(ConnectorPairPhase.Authorizing);
        expect(recovered.snapshot.renewal?.revision).toBe(1n);
        await expect(recovered.renewExpired(status)).rejects.toThrow('confirmed expired');
    },
);
