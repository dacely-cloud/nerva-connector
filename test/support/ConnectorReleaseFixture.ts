// SPDX-FileCopyrightText: 2026 Dacely <business@dacely.com>
// SPDX-License-Identifier: LicenseRef-Proprietary

import { mkdtemp, mkdir, writeFile, readFile, rm, copyFile, chmod } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { homedir } from 'node:os';
import { createHash } from 'node:crypto';
import { SigningKey } from '../../src/identity/SigningKey.js';
import {
    SignatureSuite,
    SignaturePurpose,
} from 'nerva-connector-protocol/identity/IdentityFormat.js';
import {
    ConnectorReleaseProtocol,
    ConnectorReleaseArchitecture,
    ConnectorReleasePlatform,
    ConnectorReleaseFile,
    type ConnectorReleaseArtifact,
    type ConnectorReleaseDeployment,
    type ConnectorReleaseManifest,
    type ConnectorSignedRelease,
} from '../../src/install/ConnectorRelease.js';
import { ConnectorReleaseCodec } from '../../src/install/ConnectorReleaseCodec.js';
import { ConnectorInstallerScript } from '../../src/install/ConnectorInstallerScript.js';
import { ConnectorReleaseAssets } from '../../src/install/ConnectorReleaseAssets.js';
import { ConnectorWindowsBootstrap } from '../../src/install/ConnectorWindowsBootstrap.js';

/** Release signing authority stays on the controller; only public signed assets enter the installation. */
export class ConnectorReleaseFixture implements AsyncDisposable {
    /** Each test owns all temporary publication, trust and state paths below one private directory. */
    private constructor(
        public readonly directory: string,
        public readonly key: SigningKey,
        public readonly release: ConnectorSignedRelease,
    ) {}
    /** Small synthetic executable bytes cover verification; real mode runs the exact standalone app and current Node runtime. */
    public static async create(
        real: boolean = false,
        deployment?: ConnectorReleaseDeployment,
        platform: ConnectorReleasePlatform = ConnectorReleasePlatform.Linux,
    ): Promise<ConnectorReleaseFixture> {
        const directory: string = await mkdtemp(join(homedir(), 'nerva-release-test-'));
        const key: SigningKey = SigningKey.generate();
        try {
            const assets: string = join(directory, 'assets');
            await mkdir(assets, { mode: 0o700 });
            const artifacts: ConnectorReleaseArtifact[] = [];
            for (const name of ConnectorReleaseAssets.names(platform)) {
                const path: string = join(assets, name);
                if (real) {
                    await copyFile(
                        name === ConnectorReleaseFile.Runtime
                            ? process.execPath
                            : name === ConnectorReleaseFile.License
                              ? '/usr/share/doc/nodejs/copyright'
                              : fileURLToPath(new URL('../../build/' + name, import.meta.url)),
                        path,
                    );
                    await chmod(path, ConnectorReleaseCodec.executable(name) ? 0o700 : 0o600);
                } else {
                    await writeFile(path, name + '\n', {
                        mode: ConnectorReleaseCodec.executable(name) ? 0o700 : 0o600,
                    });
                }
                const bytes: Buffer = await readFile(path);
                artifacts.push({
                    name,
                    sizeBytes: BigInt(bytes.byteLength),
                    sha256: createHash('sha256').update(bytes).digest('hex'),
                });
            }
            using authority: SigningKey = SigningKey.generate();
            const manifest: ConnectorReleaseManifest = {
                protocol: ConnectorReleaseProtocol.Current,
                releaseId: 'qualified-release',
                revision: 9007199254740993n,
                issuedAtMs: BigInt(Date.now()) - 1000n,
                expiresAtMs: BigInt(Date.now()) + 3600000n,
                platform,
                architecture: ConnectorReleaseArchitecture.X64,
                artifacts,
                deployment: deployment ?? {
                    authorityId: 'cloud',
                    publicKey: authority.publicKey,
                    endpoints: ['wss://connect.example.com/v1/connector/tunnel'],
                    verificationUri: 'https://app.example.com/chat/connectors',
                    serverCaPem: null,
                },
            };
            const release: ConnectorSignedRelease = {
                manifest,
                signature: key.sign(
                    SignaturePurpose.Release,
                    ConnectorReleaseCodec.payload(manifest),
                ),
            };
            const fixture: ConnectorReleaseFixture = new ConnectorReleaseFixture(
                directory,
                key,
                release,
            );
            await fixture.publish(release);
            await writeFile(
                join(directory, 'release-public.json'),
                JSON.stringify({ suite: SignatureSuite.MlDsa44Ed25519, publicKey: key.publicKey }),
                { mode: 0o600 },
            );
            await writeFile(
                join(directory, 'installation.json'),
                JSON.stringify({
                    releaseDirectory: assets,
                    manifestFile: join(assets, 'release.json'),
                    releasePublicKeyFile: join(directory, 'release-public.json'),
                    destination: join(directory, 'installed'),
                }),
                { mode: 0o600 },
            );
            return fixture;
        } catch (caught: unknown) {
            key[Symbol.dispose]();
            await rm(directory, { recursive: true, force: true });
            throw caught;
        }
    }
    /** Tests can sign a distinct authorized release without permitting it to overwrite an existing installation. */
    public async publish(release: ConnectorSignedRelease): Promise<void> {
        await writeFile(
            join(this.directory, 'assets', 'release.json'),
            ConnectorReleaseCodec.encode(release),
            { mode: 0o600 },
        );
        if (release.manifest.platform === ConnectorReleasePlatform.Linux) {
            await writeFile(
                join(this.directory, 'install.sh'),
                ConnectorInstallerScript.create(
                    release,
                    this.key.publicKey,
                    'https://downloads.example.com/releases/qualified/',
                ),
                { mode: 0o700 },
            );
        } else {
            await writeFile(
                join(this.directory, 'release-bootstrap.json'),
                JSON.stringify(
                    ConnectorWindowsBootstrap.configuration(
                        release,
                        this.key.publicKey,
                        'https://downloads.example.com/releases/qualified/',
                    ),
                ) + '\n',
                { mode: 0o600 },
            );
        }
    }
    /** No test-owned runtime binary, partial publication, identity or signing key survives the fixture. */
    public async [Symbol.asyncDispose](): Promise<void> {
        this.key[Symbol.dispose]();
        await rm(this.directory, { recursive: true, force: true });
    }
}
