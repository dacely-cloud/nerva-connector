// SPDX-FileCopyrightText: 2026 Dacely <business@dacely.com>
// SPDX-License-Identifier: LicenseRef-Proprietary

import type { ConnectorHostLocalGrant } from './ConnectorHostGrantTypes.js';

import { randomBytes } from 'node:crypto';
import { realpath, stat } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { SignaturePurpose } from 'nerva-connector-protocol/identity/IdentityFormat.js';
import { SigningKey } from '../identity/SigningKey.js';
import { Boundary } from 'nerva-connector-protocol/protocol/Boundary.js';
import { ConnectorHostCodec } from 'nerva-connector-protocol/protocol/ConnectorHostCodec.js';
import {
    ConnectorHostPlatform,
    ConnectorHostTool,
    type ConnectorHostProfile,
} from 'nerva-connector-protocol/protocol/ConnectorHost.js';
import { ConnectorEnrollmentCodec } from 'nerva-connector-protocol/protocol/ConnectorEnrollmentCodec.js';
import { ProtectedFiles } from '../local/ProtectedFiles.js';
import type { ConnectorClientIdentity } from './ConnectorClientConfiguration.js';
import {
    ConnectorPrivateDirectory,
    ConnectorDirectoryPurpose,
} from './ConnectorPrivateDirectory.js';
import { ConnectorHostJournal } from './ConnectorHostJournal.js';
import { HostTerminal } from '../host/HostTerminal.js';
import { HostWindowsBuild } from '../host/HostWindowsBuild.js';

/** Full-computer authority requires its own explicit local approval; saved setup choices grant nothing. */
export class ConnectorHostGrant {
    /** One current stable private directory is reused across restarts and grant revisions. */
    public static directory(identity: ConnectorClientIdentity): string {
        return join(dirname(identity.settings.privateKeyFile), 'host-access');
    }

    /** Read-only absence detection never initializes or repairs permission or journal history. */
    public static async read(
        identity: ConnectorClientIdentity,
    ): Promise<ConnectorHostLocalGrant | null> {
        const file: string = join(this.directory(identity), 'grant.json');
        if (!(await ProtectedFiles.exists(file))) {
            return null;
        }
        return this.decode(
            JSON.parse(
                new TextDecoder('utf-8', { fatal: true }).decode(
                    await ProtectedFiles.readPrivate(file, 16384),
                ),
            ),
            identity,
        );
    }

    /** Installation occurs only after the CLI/wizard's explicit full-computer review and runtime shutdown. */
    public static async install(
        identity: ConnectorClientIdentity,
        directory: string,
        enabled: boolean,
        signal: AbortSignal,
    ): Promise<ConnectorHostLocalGrant> {
        if (
            identity.settings.slot !== 0 ||
            (process.platform !== 'linux' &&
                process.platform !== 'darwin' &&
                process.platform !== 'win32')
        ) {
            throw new Error(
                'Paired host access requires the primary Windows, macOS or Linux connector',
            );
        }
        signal.throwIfAborted();
        const tasks: string = enabled
            ? await realpath(ProtectedFiles.path(directory))
            : ProtectedFiles.path(directory);
        if (enabled && !(await stat(tasks)).isDirectory()) {
            throw new Error('Existing host task directory required');
        }
        const path: string = this.directory(identity);
        await ProtectedFiles.createDirectory(path);
        await using owner: ConnectorPrivateDirectory = await ConnectorPrivateDirectory.open(
            path,
            ConnectorDirectoryPurpose.Installation,
        );
        const previous: ConnectorHostLocalGrant | null = await this.read(identity);
        if (
            previous === null &&
            ((await owner.exists('host-journal')) || (await owner.exists('host-ready')))
        ) {
            throw new Error('Host grant history is missing; preserve the original journal');
        }
        if (previous !== null) {
            await ConnectorHostJournal.initialize(owner, identity, previous);
        }
        const terminalSupported: boolean =
            enabled &&
            (await HostTerminal.available(
                process.platform === 'win32'
                    ? await HostWindowsBuild.verifiedExecutable()
                    : undefined,
            ));
        const profile: ConnectorHostProfile = {
            grantId: previous?.profile.grantId ?? randomBytes(32).toString('hex'),
            grantRevision: previous === null ? 1n : previous.profile.grantRevision + 1n,
            enabled,
            platform:
                process.platform === 'win32'
                    ? ConnectorHostPlatform.Windows
                    : process.platform === 'darwin'
                      ? ConnectorHostPlatform.MacOs
                      : ConnectorHostPlatform.Linux,
            directory: tasks,
            tools: Object.values(ConnectorHostTool).filter(
                (tool: ConnectorHostTool): boolean =>
                    terminalSupported || !tool.startsWith('terminal_'),
            ),
        };
        const unsigned: Omit<ConnectorHostLocalGrant, 'signature'> = {
            authorityId: identity.settings.authorityId,
            environmentId: identity.settings.environmentId,
            enrollmentId: identity.settings.enrollmentId,
            journalId: previous?.journalId ?? randomBytes(32).toString('hex'),
            journalInitialized: previous !== null,
            profile,
        };
        const grant: ConnectorHostLocalGrant = {
            ...unsigned,
            signature: identity.key.sign(SignaturePurpose.HostGrant, this.payload(unsigned)),
        };
        this.decode(JSON.parse(ConnectorHostCodec.encode(grant)), identity);
        await owner.cleanPartial('grant.json', 16384);
        signal.throwIfAborted();
        await owner.write(
            'grant.json',
            Buffer.from(ConnectorHostCodec.encode(grant)),
            16384,
            previous === null,
        );
        await ConnectorHostJournal.initialize(owner, identity, grant);
        if (grant.journalInitialized) {
            return this.decode(JSON.parse(ConnectorHostCodec.encode(grant)), identity);
        }
        const initialized: Omit<ConnectorHostLocalGrant, 'signature'> = {
            ...unsigned,
            journalInitialized: true,
        };
        const ready: ConnectorHostLocalGrant = {
            ...initialized,
            signature: identity.key.sign(SignaturePurpose.HostGrant, this.payload(initialized)),
        };
        await owner.write(
            'grant.json',
            Buffer.from(ConnectorHostCodec.encode(ready)),
            16384,
            false,
        );
        return this.decode(JSON.parse(ConnectorHostCodec.encode(ready)), identity);
    }

    /** The current enrolled key, account environment and backend pin must all match the saved consent. */
    public static decode(raw: unknown, identity: ConnectorClientIdentity): ConnectorHostLocalGrant {
        const value: Readonly<Record<string, unknown>> = Boundary.record(raw, [
            'authorityId',
            'environmentId',
            'enrollmentId',
            'journalId',
            'journalInitialized',
            'profile',
            'signature',
        ]);
        const grant: ConnectorHostLocalGrant = {
            authorityId: Boundary.id(value['authorityId']),
            environmentId: Boundary.id(value['environmentId']),
            enrollmentId: ConnectorEnrollmentCodec.id(value['enrollmentId']),
            journalId: ConnectorEnrollmentCodec.digest(value['journalId']),
            journalInitialized: Boundary.boolean(value['journalInitialized']),
            profile: ConnectorHostCodec.profile(value['profile']),
            signature: typeof value['signature'] === 'string' ? value['signature'] : '',
        };
        if (
            grant.authorityId !== identity.settings.authorityId ||
            grant.environmentId !== identity.settings.environmentId ||
            grant.enrollmentId !== identity.settings.enrollmentId ||
            !SigningKey.verify(
                SignaturePurpose.HostGrant,
                identity.publicKey,
                this.payload(grant),
                grant.signature,
            )
        ) {
            throw new Error('Local host consent does not match the enrolled connector');
        }
        Object.freeze(grant.profile.tools);
        Object.freeze(grant.profile);
        return Object.freeze(grant);
    }

    /** Local-grant proofs are never accepted as backend permits or remote result proofs. */
    public static payload(value: Omit<ConnectorHostLocalGrant, 'signature'>): Buffer {
        return Buffer.from(
            ConnectorHostCodec.encode([
                'nerva-connector:local-host-grant',
                value.authorityId,
                value.environmentId,
                value.enrollmentId,
                value.journalId,
                value.journalInitialized,
                value.profile,
            ]),
        );
    }
}
