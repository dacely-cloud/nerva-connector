// SPDX-FileCopyrightText: 2026 Dacely <business@dacely.com>
// SPDX-License-Identifier: LicenseRef-Proprietary

import { randomBytes, randomUUID } from 'node:crypto';
import { mkdtemp, mkdir, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';
import {
    SignaturePurpose,
    SignatureSuite,
} from 'nerva-connector-protocol/identity/IdentityFormat.js';
import {
    ConnectorHostLimits,
    ConnectorHostTool,
    type ConnectorHostPermit,
    type ConnectorHostRequest,
    type ConnectorHostCompletion,
    type ConnectorHostAcknowledgment,
} from 'nerva-connector-protocol/protocol/ConnectorHost.js';
import { ConnectorHostCodec } from 'nerva-connector-protocol/protocol/ConnectorHostCodec.js';
import { ConnectorHostProof } from '../../src/runtime/ConnectorHostProof.js';
import { ConnectorHostGrant } from '../../src/runtime/ConnectorHostGrant.js';
import { type ConnectorHostLocalGrant } from '../../src/runtime/ConnectorHostGrantTypes.js';
import { ConnectorClientHost } from '../../src/runtime/ConnectorClientHost.js';
import type { ConnectorClientIdentity } from '../../src/runtime/ConnectorClientConfiguration.js';
import type { ConnectorActivitySink } from '../../src/runtime/ConnectorActivity.js';
import type { ConnectorConnectionLog } from '../../src/runtime/ConnectorConnectionLog.js';
import { ConnectorSessionFixture } from './ConnectorSessionFixture.js';
import { ProtectedFiles } from '../../src/local/ProtectedFiles.js';
import { WindowsStateOwner } from '../../src/windows/WindowsStateOwner.js';
import {
    WindowsStateOperation,
    type WindowsStateResponse,
} from '../../src/windows/WindowsStateProtocol.js';

/** Local host tests use isolated protected storage and generated keys, never a real account or device. */
export class ConnectorHostFixture implements AsyncDisposable {
    public readonly peer: ConnectorSessionFixture = new ConnectorSessionFixture();
    public readonly identity: ConnectorClientIdentity;
    public readonly tasks: string;
    readonly #owners: Set<ConnectorClientHost> = new Set();
    readonly #qualification: string | null;
    #marked: boolean = false;
    private constructor(
        public readonly directory: string,
        qualification: string | null = null,
    ) {
        this.#qualification = qualification;
        this.tasks = join(directory, 'tasks');
        this.identity = {
            ...this.peer.identity,
            configurationFile: join(directory, 'device.json'),
            settings: {
                ...this.peer.identity.settings,
                privateKeyFile: join(directory, 'device-key.json'),
                authorityPublicKeyFile: join(directory, 'authority-public.json'),
            },
        };
    }
    /** Windows uses native private ACLs below its verified Known Folder; POSIX uses trusted home ancestry. */
    public static async create(): Promise<ConnectorHostFixture> {
        let directory: string;
        let qualification: string | null = null;
        if (process.platform === 'win32') {
            const root: WindowsStateResponse = await WindowsStateOwner.request(
                WindowsStateOperation.Root,
            );
            if (root.path === null) {
                throw new Error('Verified Windows Known Folder required');
            }
            qualification = randomUUID();
            directory = join(root.path, 'qualification-host-' + qualification);
            await ProtectedFiles.createDirectory(directory);
        } else {
            directory = await mkdtemp(join(homedir(), '.nerva-host-relay-'));
        }
        const fixture: ConnectorHostFixture = new ConnectorHostFixture(directory, qualification);
        try {
            if (qualification !== null) {
                await writeFile(join(directory, 'qualification-owner'), qualification, {
                    flag: 'wx',
                    mode: 0o600,
                });
                fixture.#marked = true;
                await ProtectedFiles.createDirectory(fixture.tasks);
            } else {
                await mkdir(fixture.tasks, { mode: 0o700 });
            }
            return fixture;
        } catch (caught: unknown) {
            await fixture[Symbol.asyncDispose]();
            throw caught;
        }
    }
    /** Direct installer invocation models the same explicit local approval used by the foreground wizard. */
    public async grant(enabled: boolean = true): Promise<ConnectorHostLocalGrant> {
        return await ConnectorHostGrant.install(
            this.identity,
            this.tasks,
            enabled,
            new AbortController().signal,
        );
    }

    /** The CLI approval test reads actual protected generated key/config files through its normal loader. */
    public async persist(): Promise<void> {
        const secret: Buffer = this.peer.device.encode();
        try {
            await writeFile(this.identity.settings.privateKeyFile, secret, { mode: 0o600 });
        } finally {
            secret.fill(0);
        }
        await writeFile(
            this.identity.settings.authorityPublicKeyFile,
            JSON.stringify({
                suite: SignatureSuite.MlDsa44Ed25519,
                publicKey: this.peer.authority.publicKey,
            }),
            { mode: 0o600 },
        );
        await writeFile(this.identity.configurationFile, JSON.stringify(this.identity.settings), {
            mode: 0o600,
        });
    }
    /** Keep every opened owner in fixture cleanup, including after a negative assertion fails. */
    public async open(
        activity: ConnectorActivitySink | null = null,
        log: ConnectorConnectionLog | null = null,
    ): Promise<ConnectorClientHost> {
        const host: ConnectorClientHost | null = await ConnectorClientHost.load(
            this.identity,
            null,
            activity,
            log,
        );
        if (host === null) {
            throw new Error('Explicit host fixture grant required');
        }
        this.#owners.add(host);
        return host;
    }
    /** One short-lived purpose-bound permit retains an exact original request and host journal. */
    public permit(
        grant: ConnectorHostLocalGrant,
        sequence: bigint,
        toolName: ConnectorHostTool,
        argumentsJson: string,
        leaseId: string = randomBytes(32).toString('base64url'),
    ): ConnectorHostPermit {
        const request: ConnectorHostRequest = {
            grantId: grant.profile.grantId,
            grantRevision: grant.profile.grantRevision,
            toolName,
            argumentsJson,
        };
        const now: bigint = BigInt(Date.now());
        return this.sign({
            authorityId: grant.authorityId,
            enrollmentId: grant.enrollmentId,
            leaseId,
            journalId: grant.journalId,
            jobId: 'host-job-' + sequence.toString(),
            sequence,
            dispatchId: randomBytes(32).toString('base64url'),
            requestHash: ConnectorHostProof.digest(ConnectorHostCodec.encode(request)),
            request,
            issuedAtMs: now,
            expiresAtMs: now + 10000n,
            startByMs: now + ConnectorHostLimits.startMs,
        });
    }
    /** Re-signing a delivery wrapper never changes its original effect identity. */
    public sign(value: Omit<ConnectorHostPermit, 'signature'>): ConnectorHostPermit {
        return {
            ...value,
            signature: ConnectorHostProof.sign(
                this.peer.authority,
                SignaturePurpose.HostPermit,
                ConnectorHostProof.permit(value),
            ),
        };
    }
    /** Only a durable account backend would issue this exact result acknowledgment in the real tunnel. */
    public acknowledgment(value: ConnectorHostCompletion): ConnectorHostAcknowledgment {
        const unsigned: Omit<ConnectorHostAcknowledgment, 'signature'> = {
            authorityId: this.identity.settings.authorityId,
            enrollmentId: value.enrollmentId,
            leaseId: value.leaseId,
            journalId: value.journalId,
            jobId: value.jobId,
            sequence: value.sequence,
            dispatchId: value.dispatchId,
            requestHash: value.requestHash,
            responseHash: value.responseHash,
        };
        return {
            ...unsigned,
            signature: ConnectorHostProof.sign(
                this.peer.authority,
                SignaturePurpose.HostAcknowledgment,
                ConnectorHostProof.acknowledgment(unsigned),
            ),
        };
    }
    /** Owned runtime cleanup joins processes and journal writes before fixture removal and key erasure. */
    public async [Symbol.asyncDispose](): Promise<void> {
        await Promise.allSettled(
            [...this.#owners].map((owner: ConnectorClientHost): Promise<void> =>
                owner[Symbol.asyncDispose](),
            ),
        );
        this.peer[Symbol.dispose]();
        if (this.#qualification !== null) {
            if (this.#marked) {
                if (
                    (await readFile(join(this.directory, 'qualification-owner'), 'utf8')) !==
                    this.#qualification
                ) {
                    throw new Error('Windows host fixture ownership changed');
                }
            } else if (
                (await readdir(this.directory)).some(
                    (name: string): boolean => name !== 'qualification-owner',
                )
            ) {
                throw new Error('Unrecognized Windows host fixture contents');
            }
        }
        await rm(this.directory, { recursive: true, force: true });
    }
}
