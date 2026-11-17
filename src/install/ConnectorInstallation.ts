// SPDX-FileCopyrightText: 2026 Nerva contributors
// SPDX-License-Identifier: LicenseRef-Proprietary

import { createHash } from 'node:crypto';
import { ConnectorLogout } from '../runtime/ConnectorLogout.js';
import { join, resolve } from 'node:path';
import { lstat } from 'node:fs/promises';
import { ProtectedFiles } from '../local/ProtectedFiles.js';
import { Boundary } from 'nerva-connector-protocol/protocol/Boundary.js';
import { IdentityCodec } from 'nerva-connector-protocol/identity/IdentityCodec.js';
import {
    ConnectorAuthorityPin,
    type ConnectorTrustedAuthority,
} from '../runtime/ConnectorAuthorityPin.js';
import { ConnectorDeviceKey, type ConnectorDeviceIdentity } from '../runtime/ConnectorDeviceKey.js';
import {
    ConnectorPairConfiguration,
    type ConnectorPairIdentity,
} from '../runtime/ConnectorPairConfiguration.js';
import {
    ConnectorClientConfiguration,
    type ConnectorClientIdentity,
} from '../runtime/ConnectorClientConfiguration.js';
import { ConnectorReleaseCodec } from './ConnectorReleaseCodec.js';
import { ConnectorReleaseArtifacts } from './ConnectorReleaseArtifacts.js';
import type { ConnectorSignedRelease } from './ConnectorRelease.js';

/** Read-only installed authority is distinct from admission of a new finite release. */
export interface ConnectorInstallationView {
    readonly directory: string;
    readonly release: ConnectorSignedRelease;
    readonly pairingFile: string;
    readonly runtimeFile: string;
    readonly stateDirectory: string;
    readonly publicKey: string;
    readonly enrolled: boolean;
}

/** Services may resume an already committed installation after its download ticket expires; they cannot admit a new release. */
export class ConnectorInstallation {
    /** Signature, all installed bytes, pinned deployment and retained original identity must agree before service execution. */
    public static async read(
        directory: string,
        signal: AbortSignal,
    ): Promise<ConnectorInstallationView> {
        if (resolve(ProtectedFiles.path(directory)) !== directory) {
            throw new Error('Canonical installation directory required');
        }
        await ProtectedFiles.directory(directory);
        const trusted: ConnectorTrustedAuthority = await ConnectorAuthorityPin.load(
            'connector-release',
            join(directory, 'release-public.json'),
        );
        const raw: unknown = JSON.parse(
            (await ProtectedFiles.readPrivate(join(directory, 'release.json'), 131072)).toString(
                'utf8',
            ),
        );
        const envelope: Readonly<Record<string, unknown>> = Boundary.record(raw, [
            'manifest',
            'signature',
        ]);
        const manifest: Readonly<Record<string, unknown>> = Boundary.record(envelope['manifest'], [
            'protocol',
            'releaseId',
            'revision',
            'issuedAtMs',
            'expiresAtMs',
            'platform',
            'architecture',
            'artifacts',
            'deployment',
        ]);
        const issuedAtMs: bigint = Boundary.integer(manifest['issuedAtMs']);
        if (issuedAtMs > BigInt(Date.now())) {
            throw new Error('Installed release issuance is in the future');
        }
        const release: ConnectorSignedRelease = ConnectorReleaseCodec.read(
            raw,
            trusted.publicKey,
            issuedAtMs,
        );
        if (
            release.manifest.platform.valueOf() !== process.platform ||
            release.manifest.architecture.valueOf() !== process.arch
        ) {
            throw new Error('Installed connector release platform mismatch');
        }
        const ready: Readonly<Record<string, unknown>> = Boundary.record(
            JSON.parse(
                (await ProtectedFiles.readPrivate(join(directory, 'ready.json'), 8192)).toString(
                    'utf8',
                ),
            ),
            ['releaseSha256', 'devicePublicKey'],
        );
        const publicKey: string = IdentityCodec.publicKey(ready['devicePublicKey']).toString(
            'base64url',
        );
        if (
            ready['releaseSha256'] !==
            createHash('sha256').update(ConnectorReleaseCodec.encode(release)).digest('hex')
        ) {
            throw new Error('Installed release commitment changed');
        }
        for (const artifact of release.manifest.artifacts) {
            await ConnectorReleaseArtifacts.verify(directory, artifact, signal);
        }
        const pairingFile: string = join(directory, 'pairing.json');
        const pairing: ConnectorPairIdentity = await ConnectorPairConfiguration.load(pairingFile);
        const stateDirectory: string = join(directory, 'state');
        const keyFile: string = join(stateDirectory, 'device-key.json');
        using identity: DisposableStack = new DisposableStack();
        const device: ConnectorDeviceIdentity = await ConnectorDeviceKey.load(keyFile);
        identity.use(device.key);
        const deployment: typeof release.manifest.deployment = release.manifest.deployment;
        if (
            device.publicKey !== publicKey ||
            pairing.settings.stateDirectory !== stateDirectory ||
            pairing.authority.publicKey !== deployment.publicKey ||
            pairing.settings.authorityId !== deployment.authorityId ||
            pairing.settings.authorityPublicKeyFile !== join(directory, 'authority-public.json') ||
            JSON.stringify(pairing.settings.endpoints) !== JSON.stringify(deployment.endpoints) ||
            pairing.settings.verificationUri !== deployment.verificationUri ||
            (pairing.ca?.toString('utf8') ?? null) !== deployment.serverCaPem ||
            pairing.settings.serverCaFile !==
                (deployment.serverCaPem === null ? null : join(directory, 'server-ca.pem'))
        ) {
            throw new Error('Installed device or deployment authority changed');
        }
        const activeFile: string = await ConnectorLogout.resolve(pairingFile, signal);
        const activePairing: ConnectorPairIdentity =
            activeFile === pairingFile
                ? pairing
                : await ConnectorPairConfiguration.load(activeFile);
        const activeDevice: ConnectorDeviceIdentity =
            activeFile === pairingFile
                ? device
                : await ConnectorDeviceKey.load(
                      join(activePairing.settings.stateDirectory, 'device-key.json'),
                  );
        if (activeDevice !== device) {
            identity.use(activeDevice.key);
        }
        const activeKeyFile: string = join(
            activePairing.settings.stateDirectory,
            'device-key.json',
        );
        const runtimeFile: string = join(activePairing.settings.stateDirectory, 'device.json');
        let enrolled: boolean = false;
        try {
            await lstat(runtimeFile);
            enrolled = true;
        } catch (caught: unknown) {
            if (!(caught instanceof Error) || !('code' in caught) || caught.code !== 'ENOENT') {
                throw caught;
            }
        }
        if (enrolled) {
            const runtime: ConnectorClientIdentity =
                await ConnectorClientConfiguration.load(runtimeFile);
            identity.use(runtime.key);
            if (
                runtime.publicKey !== activeDevice.publicKey ||
                runtime.settings.privateKeyFile !== activeKeyFile ||
                runtime.settings.authorityId !== activePairing.settings.authorityId ||
                runtime.settings.authorityPublicKeyFile !==
                    activePairing.settings.authorityPublicKeyFile ||
                runtime.settings.serverCaFile !== activePairing.settings.serverCaFile ||
                JSON.stringify(runtime.settings.endpoints) !==
                    JSON.stringify(activePairing.settings.endpoints)
            ) {
                throw new Error('Installed runtime identity changed');
            }
        }
        signal.throwIfAborted();
        return {
            directory,
            release,
            pairingFile: activeFile,
            runtimeFile,
            stateDirectory: activePairing.settings.stateDirectory,
            publicKey: activeDevice.publicKey,
            enrolled,
        };
    }
}
