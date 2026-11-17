// SPDX-FileCopyrightText: 2026 Nerva contributors
// SPDX-License-Identifier: LicenseRef-Proprietary

import { lstat } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { hostname } from 'node:os';
import { createHash } from 'node:crypto';
import { SignatureSuite } from 'nerva-connector-protocol/identity/IdentityFormat.js';
import { Boundary } from 'nerva-connector-protocol/protocol/Boundary.js';
import { ConnectorEnrollmentCodec } from 'nerva-connector-protocol/protocol/ConnectorEnrollmentCodec.js';
import { ProtectedFiles } from '../local/ProtectedFiles.js';
import {
    ConnectorAuthorityPin,
    type ConnectorTrustedAuthority,
} from '../runtime/ConnectorAuthorityPin.js';
import {
    ConnectorPrivateDirectory,
    ConnectorDirectoryPurpose,
} from '../runtime/ConnectorPrivateDirectory.js';
import type { ConnectorPairSettings } from '../runtime/ConnectorPairConfiguration.js';
import { ConnectorDeviceKey } from '../runtime/ConnectorDeviceKey.js';
import { ConnectorNodeRuntime } from '../networking/ConnectorNodeRuntime.js';
import { ConnectorReleaseCodec } from './ConnectorReleaseCodec.js';
import { ConnectorReleaseArtifacts } from './ConnectorReleaseArtifacts.js';
import type { ConnectorSignedRelease } from './ConnectorRelease.js';

/** Explicit local installation accepts paths, never account credentials or remotely chosen program grants. */
export interface ConnectorReleaseInstallationRequest {
    readonly releaseDirectory: string;
    readonly manifestFile: string;
    readonly releasePublicKeyFile: string;
    readonly destination: string;
}
/** Intentional installation outputs are stable; repeated setup preserves all device state. */
export interface ConnectorReleaseInstallationResult {
    readonly releaseId: string;
    readonly revision: string;
    readonly pairingFile: string;
    readonly runtimeFile: string;
}

/** The signed initial installer owns no service manager, sudo, host firewall or device credentials. */
export class ConnectorReleaseInstallation {
    /** Exact signed release verification and source checks finish before any destination mutation. */
    public static async install(
        requestFile: string,
        signal: AbortSignal,
    ): Promise<ConnectorReleaseInstallationResult> {
        ConnectorNodeRuntime.assertCurrent();
        const raw: unknown = JSON.parse(
            new TextDecoder('utf-8', { fatal: true }).decode(
                await ProtectedFiles.readPrivate(requestFile, 8192),
            ),
        );
        const value: Readonly<Record<string, unknown>> = Boundary.record(raw, [
            'releaseDirectory',
            'manifestFile',
            'releasePublicKeyFile',
            'destination',
        ]);
        const request: ConnectorReleaseInstallationRequest = {
            releaseDirectory: ProtectedFiles.path(value['releaseDirectory']),
            manifestFile: ProtectedFiles.path(value['manifestFile']),
            releasePublicKeyFile: ProtectedFiles.path(value['releasePublicKeyFile']),
            destination: ProtectedFiles.path(value['destination']),
        };
        for (const path of [
            request.releaseDirectory,
            request.manifestFile,
            request.releasePublicKeyFile,
            request.destination,
        ]) {
            if (resolve(path) !== path) {
                throw new Error('Canonical connector installation paths required');
            }
        }
        const trusted: ConnectorTrustedAuthority = await ConnectorAuthorityPin.load(
            'connector-release',
            request.releasePublicKeyFile,
        );
        const release: ConnectorSignedRelease = ConnectorReleaseCodec.read(
            JSON.parse(
                new TextDecoder('utf-8', { fatal: true }).decode(
                    await ProtectedFiles.readTrusted(request.manifestFile, 131072, false),
                ),
            ),
            trusted.publicKey,
            BigInt(Date.now()),
        );
        if (
            process.platform !== release.manifest.platform.valueOf() ||
            process.arch !== release.manifest.architecture.valueOf()
        ) {
            throw new Error('Connector release platform mismatch');
        }
        for (const artifact of release.manifest.artifacts) {
            await ConnectorReleaseArtifacts.verify(request.releaseDirectory, artifact, signal);
        }
        signal.throwIfAborted();
        await ProtectedFiles.createDirectory(request.destination);
        await using owner: ConnectorPrivateDirectory = await ConnectorPrivateDirectory.open(
            request.destination,
            ConnectorDirectoryPurpose.Installation,
        );
        const intent: Buffer = ConnectorReleaseCodec.encode(release);
        if (!(await owner.exists('release.json'))) {
            const names: readonly string[] = await owner.list();
            if (names.some((name: string): boolean => name !== 'release.json.partial')) {
                throw new Error('Connector installation destination is not empty');
            }
        }
        await this.#publish(owner, 'release.json', intent);
        const allowed: ReadonlySet<string> = new Set([
            'release.json',
            'release-public.json',
            'service-state.json',
            ...release.manifest.artifacts.map((artifact): string => artifact.name),
            'authority-public.json',
            'pairing.json',
            'server-ca.pem',
            'ready.json',
            'state',
            'capabilities',
            'native',
            'preferences',
        ]);
        for (const name of await owner.list()) {
            if (!allowed.has(name) && !allowed.has(name.replace(/\.partial$/u, ''))) {
                throw new Error('Unknown content in connector installation');
            }
        }
        for (const artifact of release.manifest.artifacts) {
            await ConnectorReleaseArtifacts.install(
                join(request.releaseDirectory, artifact.name),
                owner,
                artifact,
                signal,
            );
        }
        const stateDirectory: string = join(request.destination, 'state');
        const completed: boolean = await owner.exists('ready.json');
        if (completed) {
            await ProtectedFiles.directory(stateDirectory);
        } else {
            await ProtectedFiles.createDirectory(stateDirectory);
        }
        if (process.platform !== 'win32') {
            const state: Awaited<ReturnType<typeof lstat>> = await lstat(stateDirectory);
            if (state.uid !== process.getuid?.() || (state.mode & 0o077) !== 0) {
                throw new Error('Connector installation state is not private');
            }
        } else {
            const state: ConnectorPrivateDirectory = await ConnectorPrivateDirectory.open(
                stateDirectory,
                ConnectorDirectoryPurpose.Identity,
            );
            await state[Symbol.asyncDispose]();
        }
        const keyFile: string = join(stateDirectory, 'device-key.json');
        if (completed) {
            await lstat(keyFile);
        }
        const devicePublicKey: string = await ConnectorDeviceKey.initialize(keyFile);
        await this.#publish(
            owner,
            'release-public.json',
            Buffer.from(
                JSON.stringify({
                    suite: SignatureSuite.MlDsa44Ed25519,
                    publicKey: trusted.publicKey,
                }),
            ),
        );
        const deployment: typeof release.manifest.deployment = release.manifest.deployment;
        await this.#publish(
            owner,
            'authority-public.json',
            Buffer.from(
                JSON.stringify({
                    suite: SignatureSuite.MlDsa44Ed25519,
                    publicKey: deployment.publicKey,
                }),
            ),
        );
        if (deployment.serverCaPem !== null) {
            await this.#publish(owner, 'server-ca.pem', Buffer.from(deployment.serverCaPem));
        }
        const settings: ConnectorPairSettings = {
            authorityId: deployment.authorityId,
            authorityPublicKeyFile: owner.file('authority-public.json'),
            stateDirectory,
            endpoints: deployment.endpoints,
            verificationUri: deployment.verificationUri,
            deviceName: ConnectorEnrollmentCodec.name(hostname()),
            serverCaFile: deployment.serverCaPem === null ? null : owner.file('server-ca.pem'),
            files: null,
            execution: null,
        };
        await this.#publish(owner, 'pairing.json', Buffer.from(JSON.stringify(settings)));
        await this.#publish(
            owner,
            'ready.json',
            Buffer.from(
                JSON.stringify({
                    releaseSha256: createHash('sha256').update(intent).digest('hex'),
                    devicePublicKey,
                }),
            ),
        );
        return {
            releaseId: release.manifest.releaseId,
            revision: release.manifest.revision.toString(),
            pairingFile: owner.file('pairing.json'),
            runtimeFile: join(stateDirectory, 'device.json'),
        };
    }
    static async #publish(
        owner: ConnectorPrivateDirectory,
        name: string,
        bytes: Buffer,
    ): Promise<void> {
        await owner.cleanPartial(name, 131072);
        if (await owner.exists(name)) {
            const previous: Buffer = await owner.read(name, 131072);
            if (!previous.equals(bytes)) {
                throw new Error('Existing installation differs; an explicit upgrade is required');
            }
        } else {
            await owner.write(name, bytes, 131072, true);
        }
    }
}
