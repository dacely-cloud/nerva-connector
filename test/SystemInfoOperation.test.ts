// SPDX-FileCopyrightText: 2026 Nerva contributors
// SPDX-License-Identifier: LicenseRef-Proprietary

import { randomBytes } from 'node:crypto';
import { afterEach, expect, it, vi, type MockInstance } from 'vitest';
import { SigningKey } from '../src/identity/SigningKey.js';
import { IdentityLengths } from 'nerva-connector-protocol/identity/IdentityFormat.js';
import { ExchangeProof } from 'nerva-connector-protocol/remote/ExchangeProof.js';
import { ExchangeCodec } from 'nerva-connector-protocol/remote/ExchangeCodec.js';
import {
    ExchangeKind,
    type ExchangeContext,
    type SignedExchange,
} from 'nerva-connector-protocol/remote/ExchangeFormat.js';
import { SystemInfoOperation } from '../src/remote/SystemInfoOperation.js';
import { SystemInfo } from '../src/system/SystemInfo.js';
import { SystemSpecificationCodec } from 'nerva-connector-protocol/system/SystemSpecificationCodec.js';
import {
    SystemPlatform,
    GpuInventoryState,
    GpuVendor,
    type SystemSpecification,
} from 'nerva-connector-protocol/system/SystemSpecification.js';
import { GpuInventory } from '../src/system/GpuInventory.js';
import { Boundary } from 'nerva-connector-protocol/protocol/Boundary.js';
import { SessionFixture } from './support/SessionFixture.js';
import { DeviceSession } from '../src/remote/DeviceSession.js';

/** The fixture owns independent private keys and one trusted target; no network input supplies those expectations. */
class SystemOperationFixture implements Disposable {
    public readonly authority: SigningKey = SigningKey.generate();
    public readonly device: SigningKey = SigningKey.generate();
    public readonly now: bigint = BigInt(Date.now());
    public readonly context: ExchangeContext = {
        authorityId: 'cloud',
        edgeId: 'gateway',
        edgeWorkloadThumbprint: randomBytes(32).toString('base64url'),
        environmentId: 'env-user-a',
        runtimeId: 'runtime-one',
        generation: 1n,
        requestId: randomBytes(32).toString('base64url'),
        sessionId: randomBytes(32).toString('base64url'),
        recipientPublicKey: this.device.publicKey,
    };
    public request(payload: string = JSON.stringify({ action: 'system-info' })): SignedExchange {
        return ExchangeProof.sign(this.authority, {
            kind: ExchangeKind.Request,
            context: this.context,
            issuedAtMs: this.now,
            expiresAtMs: this.now + 30000n,
            payload,
        });
    }
    public async run(request: SignedExchange): Promise<SignedExchange> {
        using session: DeviceSession = SessionFixture.open(
            this.device,
            this.authority,
            this.context,
            BigInt(Date.now()),
        );
        return await SystemInfoOperation.execute(
            ExchangeCodec.encode(request),
            session,
            AbortSignal.timeout(5000),
        );
    }
    public [Symbol.dispose](): void {
        this.authority[Symbol.dispose]();
        this.device[Symbol.dispose]();
    }
}

const snapshot: SystemSpecification = Object.freeze({
    observedAtMs: '1000',
    platform: SystemPlatform.Linux,
    architecture: 'x64',
    osRelease: 'kernel',
    cpuModel: 'CPU',
    logicalCpuCount: 4,
    totalMemoryBytes: '9007199254740993',
    availableMemoryBytes: '4096',
    gpuState: GpuInventoryState.Unavailable,
    gpus: Object.freeze([]),
});

afterEach((): void => {
    vi.restoreAllMocks();
});

it('collects only after both signatures pass and returns the exact original request commitment in a signed reply', async (): Promise<void> => {
    using fixture: SystemOperationFixture = new SystemOperationFixture();
    const probe: MockInstance<typeof SystemInfo.read> = vi
        .spyOn(SystemInfo, 'read')
        .mockResolvedValue(snapshot);
    const request: SignedExchange = fixture.request();
    const result: SignedExchange = await fixture.run(request);
    expect(probe).toHaveBeenCalledTimes(1);
    const accepted: SignedExchange = ExchangeProof.verify(
        SigningKey,
        ExchangeCodec.encode(result),
        ExchangeKind.Result,
        { ...fixture.context, recipientPublicKey: fixture.authority.publicKey },
        fixture.device.publicKey,
        BigInt(Date.now()),
    );
    const value: Readonly<Record<string, unknown>> = Boundary.record(JSON.parse(accepted.payload), [
        'requestSha256',
        'specification',
    ]);
    expect(value['requestSha256']).toBe(ExchangeCodec.digest(request));
    expect(SystemSpecificationCodec.read(value['specification'])).toEqual(snapshot);
});

it('invalid signatures, expired messages, unauthorized operations and extra arguments cannot run the local probe', async (): Promise<void> => {
    using fixture: SystemOperationFixture = new SystemOperationFixture();
    const probe: MockInstance<typeof SystemInfo.read> = vi
        .spyOn(SystemInfo, 'read')
        .mockResolvedValue(snapshot);
    const original: SignedExchange = fixture.request();
    for (const index of [0, IdentityLengths.mlDsaSignature]) {
        const proof: Buffer = Buffer.from(original.signature, 'base64url');
        proof[index] ^= 1;
        await expect(
            fixture.run({ ...original, signature: proof.toString('base64url') }),
        ).rejects.toThrow();
    }
    for (const payload of [
        JSON.stringify({ action: 'exec', argv: ['id'] }),
        JSON.stringify({ action: 'system-info', executable: '/tmp/forged' }),
        '{}',
    ]) {
        await expect(fixture.run(fixture.request(payload))).rejects.toThrow();
    }
    const expired: SignedExchange = ExchangeProof.sign(fixture.authority, {
        ...original,
        issuedAtMs: fixture.now - 10000n,
        expiresAtMs: fixture.now - 1n,
    });
    await expect(fixture.run(expired)).rejects.toThrow();
    expect(probe).not.toHaveBeenCalled();
});

it('a different recipient, canceled request or expired collection never produces a signed metadata result', async (): Promise<void> => {
    using fixture: SystemOperationFixture = new SystemOperationFixture();
    const request: SignedExchange = fixture.request();
    await expect(
        SystemInfoOperation.execute(
            ExchangeCodec.encode(request),
            SessionFixture.open(
                fixture.device,
                fixture.authority,
                { ...fixture.context, environmentId: 'another-environment' },
                fixture.now,
            ),
            AbortSignal.timeout(5000),
        ),
    ).rejects.toThrow();
    await expect(
        SystemInfoOperation.execute(
            ExchangeCodec.encode(request),
            SessionFixture.open(fixture.device, fixture.authority, fixture.context, fixture.now),
            AbortSignal.abort(),
        ),
    ).rejects.toThrow();
    vi.spyOn(SystemInfo, 'read').mockImplementation(
        async (_signal: AbortSignal): Promise<SystemSpecification> => {
            vi.spyOn(Date, 'now').mockReturnValue(Number(request.expiresAtMs));
            return await Promise.resolve(snapshot);
        },
    );
    await expect(fixture.run(request)).rejects.toThrow('expired');
});

it('signed metadata is still schema-checked and preserves exact quantities without treating unavailable GPUs as CPU-only', (): void => {
    expect(SystemSpecificationCodec.read(snapshot).totalMemoryBytes).toBe('9007199254740993');
    for (const value of [
        { ...snapshot, logicalCpuCount: 0 },
        { ...snapshot, logicalCpuCount: 4097 },
        { ...snapshot, platform: 'invented' },
        { ...snapshot, availableMemoryBytes: '99999999999999999' },
        { ...snapshot, totalMemoryBytes: 4096 },
        {
            ...snapshot,
            gpus: Array.from({ length: 33 }, (): Readonly<Record<string, never>> => ({})),
        },
        { ...snapshot, privateAddress: 'sensitive' },
        { ...snapshot, cpuModel: 'CPU\nInjected' },
    ]) {
        expect((): SystemSpecification => SystemSpecificationCodec.read(value)).toThrow();
    }
});

it('GPU UUID letter case cannot duplicate a physical device in local or signed remote inventory', (): void => {
    const id: string = 'GPU-abcdefab-abcd-abcd-abcd-abcdefabcdef';
    expect((): ReturnType<typeof GpuInventory.parseNvidia> =>
        GpuInventory.parseNvidia(id + ', GPU, 100, 10\n' + id.toUpperCase() + ', GPU, 100, 10'),
    ).toThrow('Duplicate');
    expect((): SystemSpecification =>
        SystemSpecificationCodec.read({
            ...snapshot,
            gpuState: GpuInventoryState.Reported,
            gpus: [
                {
                    id,
                    vendor: GpuVendor.Nvidia,
                    model: 'GPU',
                    totalVramBytes: '100',
                    availableVramBytes: '10',
                },
                {
                    id: id.toUpperCase(),
                    vendor: GpuVendor.Nvidia,
                    model: 'GPU',
                    totalVramBytes: '100',
                    availableVramBytes: '10',
                },
            ],
        }),
    ).toThrow();
});

it('one mutually authenticated session cannot repeat the system probe after completing its original request', async (): Promise<void> => {
    using fixture: SystemOperationFixture = new SystemOperationFixture();
    const probe: MockInstance<typeof SystemInfo.read> = vi
        .spyOn(SystemInfo, 'read')
        .mockResolvedValue(snapshot);
    using session: DeviceSession = SessionFixture.open(
        fixture.device,
        fixture.authority,
        fixture.context,
        fixture.now,
    );
    const request: Buffer = ExchangeCodec.encode(fixture.request());
    await SystemInfoOperation.execute(request, session, AbortSignal.timeout(5000));
    await expect(
        SystemInfoOperation.execute(request, session, AbortSignal.timeout(5000)),
    ).rejects.toThrow();
    expect(probe).toHaveBeenCalledTimes(1);
});
