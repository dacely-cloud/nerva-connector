// SPDX-FileCopyrightText: 2026 Nerva contributors
// SPDX-License-Identifier: LicenseRef-Proprietary

import { spawn, type ChildProcess } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import type { AddressInfo } from 'node:net';
import type { Duplex } from 'node:stream';
import { join } from 'node:path';
import { afterEach, expect, it, vi, type MockInstance } from 'vitest';
import { ProtectedFiles } from '../src/local/ProtectedFiles.js';
import { HostWorkspace } from '../src/host/HostWorkspace.js';
import type { HostWorkspaceOptions } from '../src/host/HostWorkspaceTypes.js';
import { HostProcess } from '../src/host/HostProcess.js';
import { HostDesktopWayland } from '../src/host/HostDesktopWayland.js';
import type { HostDesktopInfo } from '../src/host/HostDesktopTypes.js';
import { ConnectorClient } from '../src/runtime/ConnectorClient.js';
import { ConnectorClientState } from '../src/runtime/ConnectorClientState.js';
import { ConnectorHostGrant } from '../src/runtime/ConnectorHostGrant.js';
import { ConnectorClientHost } from '../src/runtime/ConnectorClientHost.js';
import { ConnectorHostProof } from '../src/runtime/ConnectorHostProof.js';
import { ConnectorHostCodec } from '../src/protocol/ConnectorHostCodec.js';
import {
    ConnectorHostTool,
    ConnectorHostOutcome,
    type ConnectorHostPermit,
    type ConnectorHostRequest,
    type ConnectorHostCompletion,
    type ConnectorHostAcknowledgment,
    type ConnectorHostPublication,
} from '../src/protocol/ConnectorHost.js';
import type { ConnectorClientIdentity } from '../src/runtime/ConnectorClientConfiguration.js';
import { SignaturePurpose } from 'nerva-connector-protocol/identity/IdentityFormat.js';
import { ConnectorLogout } from '../src/runtime/ConnectorLogout.js';
import {
    ConnectorFrameKind,
    ConnectorTransportCodec,
    ConnectorTransportLimits,
} from '../src/protocol/ConnectorTransport.js';
import { ConnectorRevocationFixture } from './support/ConnectorRevocationFixture.js';
import { SocketFixture } from './support/SocketFixture.js';
import { ConnectorLifecyclePeer } from './support/ConnectorLifecyclePeer.js';
import type { ConnectorClientFrame } from '../src/protocol/ConnectorTransport.js';
import { SystemInfo } from '../src/system/SystemInfo.js';
import type { SystemSpecification } from 'nerva-connector-protocol/system/SystemSpecification.js';

afterEach((): void => {
    vi.restoreAllMocks();
});

/** Actual local owners are captured at construction without replacing their native cleanup. */
interface OwnedResources {
    workspace: HostWorkspace | null;
    process: HostProcess | null;
    host: ConnectorClientHost | null;
}

/** The generated test authority admits real native work through the production host verifier. */
function permit(
    fixture: ConnectorRevocationFixture,
    host: ConnectorClientHost,
    sequence: bigint,
    tool: ConnectorHostTool,
    argumentsJson: string,
    leaseId: string = randomBytes(32).toString('base64url'),
): ConnectorHostPermit {
    const request: ConnectorHostRequest = {
        grantId: host.grant.profile.grantId,
        grantRevision: host.grant.profile.grantRevision,
        toolName: tool,
        argumentsJson,
    };
    const now: bigint = BigInt(Date.now());
    const unsigned: Omit<ConnectorHostPermit, 'signature'> = {
        authorityId: host.grant.authorityId,
        enrollmentId: host.grant.enrollmentId,
        leaseId,
        journalId: host.grant.journalId,
        jobId: 'retirement-' + sequence.toString(),
        sequence,
        dispatchId: randomBytes(32).toString('base64url'),
        requestHash: ConnectorHostProof.digest(ConnectorHostCodec.encode(request)),
        request,
        issuedAtMs: now,
        expiresAtMs: now + 10000n,
        startByMs: now + 10000n,
    };
    return {
        ...unsigned,
        signature: ConnectorHostProof.sign(
            fixture.session.authority,
            SignaturePurpose.HostPermit,
            ConnectorHostProof.permit(unsigned),
        ),
    };
}

/** The first original is durably acknowledged before the pending desktop original is admitted. */
function acknowledge(
    fixture: ConnectorRevocationFixture,
    host: ConnectorClientHost,
    completion: ConnectorHostCompletion,
): ConnectorHostAcknowledgment {
    const unsigned: Omit<ConnectorHostAcknowledgment, 'signature'> = {
        authorityId: host.grant.authorityId,
        enrollmentId: completion.enrollmentId,
        leaseId: completion.leaseId,
        journalId: completion.journalId,
        jobId: completion.jobId,
        sequence: completion.sequence,
        dispatchId: completion.dispatchId,
        requestHash: completion.requestHash,
        responseHash: completion.responseHash,
    };
    return {
        ...unsigned,
        signature: ConnectorHostProof.sign(
            fixture.session.authority,
            SignaturePurpose.HostAcknowledgment,
            ConnectorHostProof.acknowledgment(unsigned),
        ),
    };
}

it.skipIf(process.platform !== 'linux')(
    'signed retirement cancels desktop consent and owned processes before releasing runtime authority or selecting a successor',
    async (): Promise<void> => {
        await using tls: SocketFixture = await SocketFixture.create(
            ConnectorTransportLimits.protocol,
        );
        const address: AddressInfo | string | null = tls.server.address();
        if (address === null || typeof address === 'string') {
            throw new Error('Actual TLS listener required');
        }
        await using fixture: ConnectorRevocationFixture = await ConnectorRevocationFixture.create(
            'wss://localhost:' + address.port.toString() + ConnectorTransportLimits.path,
            tls.certificate,
        );
        const tasks: string = join(fixture.directory, 'tasks');
        await ProtectedFiles.createDirectory(tasks);
        await ConnectorHostGrant.install(
            fixture.identity,
            tasks,
            true,
            new AbortController().signal,
        );
        const captured: OwnedResources = { workspace: null, process: null, host: null };
        const loadHost: typeof ConnectorClientHost.load =
            ConnectorClientHost.load.bind(ConnectorClientHost);
        vi.spyOn(ConnectorClientHost, 'load').mockImplementation(
            async (identity: ConnectorClientIdentity): Promise<ConnectorClientHost | null> => {
                const host: ConnectorClientHost | null = await loadHost(identity);
                captured.host = host;
                return host;
            },
        );
        const createWorkspace: typeof HostWorkspace.create =
            HostWorkspace.create.bind(HostWorkspace);
        vi.spyOn(HostWorkspace, 'create').mockImplementation(
            async (options: HostWorkspaceOptions): Promise<HostWorkspace> => {
                const workspace: HostWorkspace = await createWorkspace({
                    ...options,
                    desktopEnvironment: {
                        WAYLAND_DISPLAY: 'isolated-fixture',
                        DISPLAY: '',
                        DBUS_SESSION_BUS_ADDRESS: '',
                    },
                });
                captured.workspace = workspace;
                return workspace;
            },
        );
        const createProcess: typeof HostProcess.create = HostProcess.create.bind(HostProcess);
        vi.spyOn(HostProcess, 'create').mockImplementation(
            async (...args: Parameters<typeof HostProcess.create>): Promise<HostProcess> => {
                const child: HostProcess = await createProcess(...args);
                captured.process = child;
                return child;
            },
        );
        const consent: PromiseWithResolvers<HostDesktopInfo> =
            Promise.withResolvers<HostDesktopInfo>();
        const desktopEntered: PromiseWithResolvers<undefined> = Promise.withResolvers<undefined>();
        vi.spyOn(HostDesktopWayland.prototype, 'info').mockImplementation(
            (): Promise<HostDesktopInfo> => {
                desktopEntered.resolve(undefined);
                return consent.promise;
            },
        );
        const closeDesktop: HostDesktopWayland[typeof Symbol.asyncDispose] =
            HostDesktopWayland.prototype[Symbol.asyncDispose];
        const desktopClosed: MockInstance<HostDesktopWayland[typeof Symbol.asyncDispose]> = vi
            .spyOn(HostDesktopWayland.prototype, Symbol.asyncDispose)
            .mockImplementation(async function (this: HostDesktopWayland): Promise<void> {
                consent.reject(new Error('Native consent canceled by retirement'));
                await closeDesktop.call(this);
            });
        const cleanupEntered: PromiseWithResolvers<undefined> = Promise.withResolvers<undefined>();
        const allowCleanup: PromiseWithResolvers<undefined> = Promise.withResolvers<undefined>();
        const closeWorkspace: HostWorkspace[typeof Symbol.asyncDispose] =
            HostWorkspace.prototype[Symbol.asyncDispose];
        vi.spyOn(HostWorkspace.prototype, Symbol.asyncDispose).mockImplementation(async function (
            this: HostWorkspace,
        ): Promise<void> {
            cleanupEntered.resolve(undefined);
            await allowCleanup.promise;
            await closeWorkspace.call(this);
        });
        const states: ConnectorClientState[] = [];
        vi.spyOn(SystemInfo, 'read').mockImplementation(
            async (signal: AbortSignal): Promise<SystemSpecification> => {
                await new Promise<void>((resolve: () => void): void => {
                    if (signal.aborted) {
                        resolve();
                    } else {
                        signal.addEventListener('abort', (): void => resolve(), { once: true });
                    }
                });
                signal.throwIfAborted();
                throw new Error('Retired inventory cannot complete');
            },
        );
        await using client: ConnectorClient = await ConnectorClient.load(
            fixture.identity.configurationFile,
            (state: ConnectorClientState): void => {
                states.push(state);
            },
        );
        const workspace: HostWorkspace | null = captured.workspace;
        if (workspace === null) {
            throw new Error('Actual granted workspace required');
        }
        const unrelated: ChildProcess = spawn(
            process.execPath,
            ['-e', 'setInterval(()=>{},1000)'],
            { stdio: 'ignore' },
        );
        const stop: AbortController = new AbortController();
        const running: Promise<void> = client.run(stop.signal);
        let pendingDesktop: Promise<PromiseSettledResult<ConnectorHostCompletion>[]> | null = null;
        const unhandledConsent: Promise<PromiseSettledResult<HostDesktopInfo>[]> =
            Promise.allSettled([consent.promise]);
        try {
            const socket: Duplex = await tls.upgraded.promise;
            const publication: PromiseWithResolvers<ConnectorHostPublication> =
                Promise.withResolvers<ConnectorHostPublication>();
            new ConnectorLifecyclePeer(
                socket,
                fixture.session,
                (frame: ConnectorClientFrame): void => {
                    if (frame.kind === ConnectorFrameKind.HostProfile) {
                        publication.resolve(frame.publication);
                    } else {
                        throw new Error('Unexpected extra authenticated frame');
                    }
                },
            );
            const profile: ConnectorHostPublication = await publication.promise;
            const host: ConnectorClientHost | null = captured.host;
            if (host === null) {
                throw new Error('Actual host authority required');
            }
            const start: ConnectorHostPermit = permit(
                fixture,
                host,
                1n,
                ConnectorHostTool.ProcessStart,
                JSON.stringify({
                    executable: process.execPath,
                    arguments: ['-e', 'setInterval(()=>{},1000)'],
                    shell: null,
                    command: null,
                    directory: null,
                    environment: {},
                    timeoutMs: 10000,
                }),
            );
            const started: ConnectorHostCompletion = await host.execute(
                start,
                start.leaseId,
                start.expiresAtMs,
            );
            expect(started.response.outcome).toBe(ConnectorHostOutcome.Succeeded);
            await host.acknowledge(acknowledge(fixture, host, started), start.leaseId);
            const owned: HostProcess | null = captured.process;
            if (owned === null) {
                throw new Error('Actual owned child required');
            }
            const text: ConnectorHostPermit = permit(
                fixture,
                host,
                2n,
                ConnectorHostTool.DesktopText,
                JSON.stringify({ text: 'must not reach any real desktop' }),
                profile.leaseId,
            );
            const desktopBody: Buffer = Buffer.from(
                ConnectorTransportCodec.encode({
                    kind: ConnectorFrameKind.HostPermit,
                    permit: text,
                }),
            );
            const desktopHeader: Buffer = Buffer.alloc(4);
            desktopHeader[0] = 0x81;
            desktopHeader[1] = 126;
            desktopHeader.writeUInt16BE(desktopBody.length, 2);
            socket.write(Buffer.concat([desktopHeader, desktopBody]));
            await desktopEntered.promise;
            pendingDesktop = Promise.allSettled([
                host.execute(text, text.leaseId, text.expiresAtMs),
            ]);
            const body: Buffer = Buffer.from(
                ConnectorTransportCodec.encode({
                    kind: ConnectorFrameKind.Unpaired,
                    receipt: fixture.receipt(),
                }),
            );
            const header: Buffer = Buffer.alloc(4);
            header[0] = 0x81;
            header[1] = 126;
            header.writeUInt16BE(body.length, 2);
            socket.end(Buffer.concat([header, body]));
            await cleanupEntered.promise;
            await expect(ConnectorLogout.requireActive(fixture.state)).rejects.toThrow(
                'logged out',
            );
            await expect(
                ConnectorLogout.resolve(fixture.pairingFile, new AbortController().signal),
            ).rejects.toThrow();
            expect(states).not.toContain(ConnectorClientState.Revoked);
            expect(owned.snapshot(0n, 0n, 1).running).toBe(true);
            allowCleanup.resolve(undefined);
            await running;
            expect(states.at(-1)).toBe(ConnectorClientState.Revoked);
            expect(owned.snapshot(0n, 0n, 1).running).toBe(false);
            expect(desktopClosed).toHaveBeenCalledTimes(1);
            expect(await pendingDesktop).toMatchObject([
                {
                    status: 'fulfilled',
                    value: { response: { outcome: ConnectorHostOutcome.Indeterminate } },
                },
            ]);
            await expect(workspace.desktopText('retired input')).rejects.toThrow();
            if (unrelated.pid === undefined) {
                throw new Error('Unrelated child must have started');
            }
            expect((): void => {
                process.kill(unrelated.pid ?? 0, 0);
            }).not.toThrow();
            expect(
                await ConnectorLogout.resolve(fixture.pairingFile, new AbortController().signal),
            ).not.toBe(fixture.pairingFile);
        } finally {
            allowCleanup.resolve(undefined);
            consent.reject(new Error('Fixture cleanup'));
            stop.abort();
            unrelated.kill();
            await client[Symbol.asyncDispose]();
            await running;
            await pendingDesktop;
            await unhandledConsent;
        }
    },
    15000,
);
