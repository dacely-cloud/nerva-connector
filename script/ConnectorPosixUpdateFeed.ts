// SPDX-FileCopyrightText: 2026 Dacely <business@dacely.com>
// SPDX-License-Identifier: LicenseRef-Proprietary

import { createHash, createPublicKey, sign } from 'node:crypto';
import { readdir, rm } from 'node:fs/promises';
import { basename, join } from 'node:path';
import { ConnectorUpdateManifest } from '../src/update/ConnectorUpdateManifest.ts';
import { ConnectorUpdatePaths } from '../src/update/ConnectorUpdatePaths.ts';
import type {
    ConnectorUpdatePlatform,
    ConnectorUpdateSetup,
    ConnectorUpdateSettings,
} from '../src/update/ConnectorUpdateProtocol.ts';
import {
    ConnectorPosixUpdateBuild,
    type ConnectorPosixUpdateConfiguration,
} from './ConnectorPosixUpdateBuild.ts';
import { ConnectorBuildArtifact } from './ConnectorBuildArtifact.ts';

/** Exact JSON wire fields use decimal sizes instead of unsafe floating-point byte counts. */
interface ConnectorEncodedUpdateFile {
    readonly name: string;
    readonly size: string;
    readonly sha256: string;
}

/** Publishes the same RSA-authenticated update contract as Windows, separated by native product and architecture. */
export class ConnectorPosixUpdateFeed {
    /** Every installer is checked before any output is replaced; the private key must match the authority compiled into installed copies. */
    public static async write(
        directory: string,
        platform: ConnectorUpdatePlatform,
        version: string,
        setups: readonly ConnectorUpdateSetup[],
        privateKey: string,
    ): Promise<void> {
        ConnectorUpdateManifest.version(version);
        const configuration: ConnectorPosixUpdateConfiguration =
            await ConnectorPosixUpdateBuild.configuration();
        if (
            createPublicKey(privateKey).export({ type: 'spki', format: 'pem' }) !==
            createPublicKey(configuration.publicKey).export({ type: 'spki', format: 'pem' })
        ) {
            throw new Error('This private key does not match the installed POSIX update authority');
        }
        if (setups.length < 1 || setups.length > 2) {
            throw new Error('Publish one or two distinct native architecture installers');
        }
        const files: Record<string, ConnectorEncodedUpdateFile> = {};
        const payloads: Map<string, Buffer> = new Map();
        const extension: string = platform === 'linux' ? 'run' : 'dmg';
        for (const setup of setups) {
            const expected: string = `Nerva-Connector-Setup-${version}-${setup.architecture}.${extension}`;
            if (basename(setup.path) !== expected || files[setup.architecture] !== undefined) {
                throw new Error('Installer name or architecture differs from its release');
            }
            const bytes: Buffer = await ConnectorUpdatePaths.read(
                setup.path,
                Number(ConnectorUpdateManifest.maximumInstallerBytes),
            );
            if (bytes.byteLength === 0) {
                throw new Error('Cannot publish an empty installer');
            }
            files[setup.architecture] = {
                name: expected,
                size: bytes.byteLength.toString(),
                sha256: createHash('sha256').update(bytes).digest('hex'),
            };
            payloads.set(expected, bytes);
        }
        const latest: Buffer = Buffer.from(
            JSON.stringify({
                product: platform === 'linux' ? 'nerva-connector-linux' : 'nerva-connector-macos',
                version,
                files,
            }),
        );
        const signature: string = sign('sha256', latest, privateKey).toString('base64');
        const settings: ConnectorUpdateSettings = await ConnectorPosixUpdateBuild.settings(
            platform,
            setups[0].architecture,
            '0.0.0',
            '0'.repeat(64),
        );
        ConnectorUpdateManifest.select(latest, signature, settings);
        await ConnectorUpdatePaths.create(directory, false);
        for (const [name, bytes] of payloads) {
            await ConnectorBuildArtifact.publish(join(directory, name), bytes, 0o644);
            await ConnectorBuildArtifact.publish(
                join(directory, name + '.sha256'),
                `${createHash('sha256').update(bytes).digest('hex')}  ${name}\n`,
                0o644,
            );
        }
        await ConnectorBuildArtifact.publish(join(directory, 'latest.json'), latest, 0o644);
        await ConnectorBuildArtifact.publish(
            join(directory, 'latest.json.sig'),
            signature + '\n',
            0o644,
        );
        for (const name of await readdir(directory)) {
            if (
                /^Nerva-Connector-Setup-[0-9]+\.[0-9]+\.[0-9]+-(x64|arm64)\.(run|dmg)(\.sha256)?$/u.test(
                    name,
                ) &&
                !payloads.has(name.replace(/\.sha256$/u, ''))
            ) {
                await rm(join(directory, name));
            }
        }
    }
}
