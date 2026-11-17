// SPDX-FileCopyrightText: 2026 Nerva contributors
// SPDX-License-Identifier: LicenseRef-Proprietary

import { join, resolve } from 'node:path';
import { ConnectorNpmLauncher } from '../src/install/ConnectorNpmLauncher.ts';
import { ConnectorReleaseCodec } from '../src/install/ConnectorReleaseCodec.ts';
import { ConnectorInstallerScript } from '../src/install/ConnectorInstallerScript.ts';
import {
    ConnectorReleasePlatform,
    type ConnectorSignedRelease,
} from '../src/install/ConnectorRelease.ts';
import { ConnectorWindowsBootstrap } from '../src/install/ConnectorWindowsBootstrap.ts';
import { ConnectorBootstrapWindowsBuild } from './ConnectorBootstrapWindowsBuild.ts';
import { ConnectorNpmPackageDirectory } from './ConnectorNpmPackageDirectory.ts';
import { WindowsStateArtifactFile } from '../src/windows/WindowsStateArtifactFile.ts';
import type { WindowsStateArtifact } from '../src/windows/WindowsStateArtifact.ts';
import { ConnectorReleasePublisher } from './ConnectorReleasePublisher.ts';
import { ConnectorReleaseSources } from './ConnectorReleaseSources.ts';
import { ProtectedFiles } from '../src/local/ProtectedFiles.ts';
import {
    ConnectorPrivateDirectory,
    ConnectorDirectoryPurpose,
} from '../src/runtime/ConnectorPrivateDirectory.ts';

/** The public npm package contains no dependencies, runtime copies, source tree or installation hook. */
interface ConnectorNpmManifest {
    readonly name: string;
    readonly version: string;
    readonly description: string;
    readonly license: string;
    readonly homepage: string;
    readonly os: readonly string[];
    readonly cpu: readonly string[];
    readonly bin: Readonly<Record<string, string>>;
    readonly files: readonly string[];
    readonly engines: Readonly<Record<string, string>>;
}

/** Builds a small registry-ready bootstrap from an already reviewed dual-signed release. */
export class ConnectorNpmPackage {
    /** Validate the explicit publisher version before any release output can change. */
    public static version(raw: unknown): string {
        if (typeof raw !== 'string' || raw.length > 64) {
            throw new Error('Explicit npm release version required');
        }
        const match: RegExpExecArray | null =
            /^(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)(?:-([A-Za-z0-9-]+(?:\.[A-Za-z0-9-]+)*))?$/u.exec(
                raw,
            );
        if (
            match === null ||
            match
                .slice(1, 4)
                .some((component: string): boolean => BigInt(component) > 9007199254740991n) ||
            match[4]
                ?.split('.')
                .some(
                    (component: string): boolean =>
                        /^[0-9]+$/u.test(component) &&
                        component.length > 1 &&
                        component.startsWith('0'),
                )
        ) {
            throw new Error('Explicit npm release version required');
        }
        return raw;
    }
    /** The caller owns its source release; only public pins, fixed scripts and package metadata enter this stable output. */
    public static async prepare(
        directory: string,
        version: string,
        release: ConnectorSignedRelease,
        publicKey: string,
        downloadBaseUrl: string,
        bootstrapDirectory: string = resolve('build'),
        preparedBootstrap: WindowsStateArtifact | null = null,
        signal?: AbortSignal,
    ): Promise<string> {
        signal?.throwIfAborted();
        this.version(version);
        const raw: unknown = JSON.parse(ConnectorReleaseCodec.encode(release).toString('utf8'));
        ConnectorReleaseCodec.read(raw, publicKey, BigInt(Date.now()));
        const windows: boolean = release.manifest.platform === ConnectorReleasePlatform.Windows;
        const files: Map<string, Buffer> = new Map();
        if (windows) {
            let artifact: WindowsStateArtifact;
            if (preparedBootstrap === null) {
                await ConnectorReleaseSources.externalBuildDirectory(bootstrapDirectory);
                artifact = await ConnectorBootstrapWindowsBuild.build(bootstrapDirectory);
            } else {
                await ProtectedFiles.directory(bootstrapDirectory);
                artifact = await ConnectorBootstrapWindowsBuild.cached(bootstrapDirectory);
                if (
                    artifact.bytes !== preparedBootstrap.bytes ||
                    artifact.sha256 !== preparedBootstrap.sha256 ||
                    artifact.sourceSha256 !== preparedBootstrap.sourceSha256
                ) {
                    throw new Error(
                        'Prepared bootstrap does not match the current verified source cache',
                    );
                }
            }
            files.set(
                'launcher.cjs',
                Buffer.from(
                    ConnectorWindowsBootstrap.launcher(
                        ConnectorWindowsBootstrap.configuration(
                            release,
                            publicKey,
                            downloadBaseUrl,
                        ),
                        artifact,
                        version,
                    ),
                ),
            );
            files.set(
                'nerva-connector-bootstrap.exe',
                await WindowsStateArtifactFile.read(
                    join(bootstrapDirectory, 'nerva-connector-bootstrap.exe'),
                    artifact,
                ),
            );
        } else {
            const installer: string = ConnectorInstallerScript.create(
                release,
                publicKey,
                downloadBaseUrl,
            );
            files.set('install-connector.sh', Buffer.from(installer));
            files.set(
                'launcher.sh',
                Buffer.from(ConnectorNpmLauncher.create(release, publicKey, installer, version)),
            );
        }
        const packageName: string = windows
            ? 'nerva-connector-win32-' + release.manifest.architecture
            : 'nerva-connector';
        const manifest: ConnectorNpmManifest = {
            name: packageName,
            version,
            description:
                'Connect your ' +
                (windows ? 'Windows' : 'Linux') +
                ' machine to your Nerva account with a pairing code.',
            license: 'LicenseRef-Proprietary',
            homepage: 'https://nervalabs.com',
            os: [release.manifest.platform],
            cpu: [release.manifest.architecture],
            bin: { nexa: windows ? 'launcher.cjs' : 'launcher.sh' },
            files: [...files.keys(), 'README.md'],
            engines: { node: '>=18' },
        };
        const documentation: string =
            '# Nerva Connector\n\n```sh\nnpm i -g ' +
            packageName +
            '\nnexa connector\n```\n\nOpen ' +
            release.manifest.deployment.verificationUri +
            ' and enter the displayed eight-character code.\nPublic trust settings are installed automatically. The first run verifies the signed runtime;\nlater runs reuse that exact installation. Nothing executes during npm installation.\n\nRun `nexa connector --help` for status, pairing recovery and offline setup.\nThis package targets ' +
            (windows ? 'Windows' : 'Linux') +
            ' on ' +
            release.manifest.architecture +
            '. File/command access requires\nseparate explicit local grants. The application and Node/native dependency licenses are\nretained in the verified installed release. This package is the initial bootstrap trust root;\nobtain it through your trusted npm registry or administrator channel.\n' +
            (windows
                ? '\nThe precompiled native helper establishes private Windows storage before downloaded Node or application code executes. No runtime compilation or PowerShell is used. Windows runtime qualification remains a separate required release check; cross-compilation alone does not qualify it. Windows services are not provided by this package.\n'
                : '');
        files.set('README.md', Buffer.from(documentation));
        files.set('package.json', Buffer.from(JSON.stringify(manifest, null, 4) + '\n'));
        if (
            [...files].some(
                ([name, bytes]: [string, Buffer]): boolean =>
                    bytes.byteLength > (name.endsWith('.exe') ? 262144 : 131072),
            ) ||
            [...files.values()].reduce(
                (total: number, bytes: Buffer): number => total + bytes.byteLength,
                0,
            ) > (windows ? 524288 : 262144)
        ) {
            throw new Error('Npm bootstrap exceeds its finite package policy');
        }
        await ConnectorNpmPackageDirectory.create(directory);
        await using owner: ConnectorPrivateDirectory = await ConnectorPrivateDirectory.open(
            directory,
            ConnectorDirectoryPurpose.Installation,
        );
        const generated: ReadonlySet<string> = new Set([
            'launcher.sh',
            'install-connector.sh',
            'launcher.cjs',
            'nerva-connector-bootstrap.exe',
            'README.md',
            'package.json',
        ]);
        for (const name of await owner.list()) {
            if (!generated.has(name) && !generated.has(name.replace(/\.partial$/u, ''))) {
                throw new Error('Unknown content in npm package output');
            }
        }
        for (const [name, bytes] of files) {
            signal?.throwIfAborted();
            await ConnectorReleasePublisher.write(owner, name, bytes);
        }
        for (const name of generated) {
            signal?.throwIfAborted();
            if (!files.has(name)) {
                await owner.cleanPartial(name, 262144);
                if (await owner.exists(name)) {
                    await owner.remove(name, 262144);
                }
            }
        }
        return directory;
    }
}
