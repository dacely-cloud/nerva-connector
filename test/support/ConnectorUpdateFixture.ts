// SPDX-FileCopyrightText: 2026 Nerva contributors
// SPDX-License-Identifier: LicenseRef-Proprietary

import { execFile } from 'node:child_process';
import { createHash, generateKeyPairSync, sign } from 'node:crypto';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join, resolve } from 'node:path';
import { promisify } from 'node:util';
import { vi } from 'vitest';
import { ConnectorBuildArtifact } from '../../script/ConnectorBuildArtifact.ts';
import { ConnectorLinuxInstaller } from '../../script/ConnectorLinuxInstaller.ts';
import { ConnectorMacInstaller } from '../../script/ConnectorMacInstaller.ts';
import { ConnectorPosixUpdateBuild } from '../../script/ConnectorPosixUpdateBuild.ts';
import { ConnectorUpdateFiles } from '../../src/update/ConnectorUpdateFiles.js';
import {
    ConnectorUpdatePlatform,
    type ConnectorUpdateRelease,
    type ConnectorUpdateSettings,
} from '../../src/update/ConnectorUpdateProtocol.js';
import { ConnectorUpdatePackage } from '../../src/update/ConnectorUpdatePackage.js';

/** Ephemeral signing material is scoped to one isolated update fixture and never uses the product release key. */
interface ConnectorFixtureUpdateKey {
    readonly publicKey: string;
    readonly privateKey: string;
}

/** Real native swaps and real platform packages use tiny console fixtures, with account state kept outside program trees. */
export class ConnectorUpdateFixture implements AsyncDisposable {
    /** Fixture creation owns exactly one private directory and one finite current/native target. */
    private constructor(
        public readonly directory: string,
        public readonly settings: ConnectorUpdateSettings,
        public readonly key: ConnectorFixtureUpdateKey,
        public readonly installer: string,
        public readonly supervised: boolean,
    ) {}

    /** Builds two real supervisor versions and one native installer using the platform's already built helper. */
    public static async create(supervised: boolean = false): Promise<ConnectorUpdateFixture> {
        const directory: string = await mkdtemp(join(homedir(), 'nerva-update-test-'));
        const platform: ConnectorUpdatePlatform =
            process.platform === 'darwin'
                ? ConnectorUpdatePlatform.Mac
                : ConnectorUpdatePlatform.Linux;
        const architecture: ConnectorUpdateSettings['architecture'] =
            process.arch === 'arm64' ? 'arm64' : 'x64';
        const key: ConnectorFixtureUpdateKey = generateKeyPairSync('rsa', {
            modulusLength: 3072,
            publicKeyEncoding: { type: 'spki', format: 'pem' },
            privateKeyEncoding: { type: 'pkcs8', format: 'pem' },
        });
        const helper: Buffer = await readFile(resolve('build/nerva-connector-update'));
        const settings: ConnectorUpdateSettings = {
            version: '1.0.0',
            platform,
            architecture,
            feedUrl: 'https://127.0.0.1:9/updates/',
            publicKey: key.publicKey,
            helperSha256: createHash('sha256').update(helper).digest('hex'),
            files: ConnectorUpdateFiles.names(platform),
        };
        const installer: string = join(
            directory,
            `Nerva-Connector-Setup-1.1.0-${architecture}.${platform === ConnectorUpdatePlatform.Linux ? 'run' : 'dmg'}`,
        );
        const fixture: ConnectorUpdateFixture = new ConnectorUpdateFixture(
            directory,
            settings,
            key,
            installer,
            supervised,
        );
        try {
            await fixture.program(fixture.current, '1.0.0');
            const work: string = join(directory, 'package');
            await mkdir(work, { mode: 0o700 });
            const next: string =
                platform === ConnectorUpdatePlatform.Linux
                    ? join(work, 'next')
                    : join(work, 'image/Nerva Connector.app');
            await fixture.program(next, '1.1.0');
            if (platform === ConnectorUpdatePlatform.Linux) {
                await ConnectorLinuxInstaller.build(
                    next,
                    installer,
                    architecture,
                    new AbortController().signal,
                );
            } else {
                await ConnectorMacInstaller.build(work, installer, new AbortController().signal);
            }
            await rm(work, { recursive: true });
            return fixture;
        } catch (caught: unknown) {
            await fixture[Symbol.asyncDispose]();
            throw caught;
        }
    }

    /** Linux programs and Mac bundles both have a private, writable custom installation path. */
    public get current(): string {
        return join(
            this.directory,
            this.settings.platform === ConnectorUpdatePlatform.Linux
                ? 'Custom Connector'
                : 'Nerva Connector.app',
        );
    }

    /** Writes only the declared product file catalog and compiles the actual update supervisor with test authority. */
    public async program(root: string, version: string): Promise<void> {
        const application: string = ConnectorUpdatePackage.program(root, this.settings.platform);
        await mkdir(application, { recursive: true, mode: 0o700 });
        for (const file of this.settings.files) {
            await ConnectorBuildArtifact.publish(join(application, file), file + '\n', 0o600);
        }
        const node: string =
            '#!/bin/sh\nexec ' + "'" + process.execPath.replaceAll("'", "'\\''") + "'" + ' "$@"\n';
        await ConnectorBuildArtifact.publish(join(application, 'node'), node, 0o700);
        await ConnectorBuildArtifact.publish(
            join(application, 'nerva-connector.mjs'),
            this.#console(version),
            0o700,
        );
        await ConnectorBuildArtifact.publish(
            join(application, 'nerva-connector'),
            await readFile(resolve('assets/posix/nerva-connector')),
            0o700,
        );
        const helper: Buffer = await readFile(resolve('build/nerva-connector-update'));
        await ConnectorBuildArtifact.publish(
            join(application, 'nerva-connector-update'),
            helper,
            0o700,
        );
        if (this.settings.platform === ConnectorUpdatePlatform.Linux) {
            await ConnectorBuildArtifact.publish(
                join(application, '.nerva-installation'),
                'nerva-connector-linux-v1\n',
                0o600,
            );
        }
        await ConnectorPosixUpdateBuild.build(join(application, 'nerva-connector-update.mjs'), {
            ...this.settings,
            version,
        });
        if (this.settings.platform === ConnectorUpdatePlatform.Mac) {
            const executable: string = join(root, 'Contents/MacOS');
            await mkdir(executable, { recursive: true, mode: 0o700 });
            await ConnectorBuildArtifact.publish(join(executable, 'launcher'), helper, 0o700);
            await ConnectorBuildArtifact.publish(
                join(root, 'Contents/Info.plist'),
                '<?xml version="1.0" encoding="UTF-8"?><!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd"><plist version="1.0"><dict><key>CFBundleIdentifier</key><string>com.nervalabs.update-fixture</string><key>CFBundleExecutable</key><string>launcher</string><key>CFBundlePackageType</key><string>APPL</string><key>CFBundleVersion</key><string>' +
                    version +
                    '</string></dict></plist>',
                0o600,
            );
            await promisify(execFile)('/usr/bin/codesign', ['--force', '--sign', '-', root], {
                timeout: 30000,
                maxBuffer: 65536,
            });
        }
    }

    /** Interactive fixtures use real IPC and SIGTERM; smoke probes remain finite like the production CLI. */
    #console(version: string): string {
        if (!this.supervised) {
            return 'process.stdout.write("Fixture console ' + version + '");\n';
        }
        return `import { appendFileSync } from 'node:fs';
const version = ${JSON.stringify(version)};
if (process.argv.includes('--help')) {
    process.stdout.write('Fixture console ' + version);
} else {
    const receipt = process.env['NERVA_UPDATE_TEST_RECEIPT'];
    const record = (event) => appendFileSync(receipt, version + ':' + event + '\\n');
    record('start');
    process.on('SIGTERM', () => { record('stop'); process.exit(0); });
    process.on('disconnect', () => process.exit(0));
    process.on('message', (message) => {
        if (version === '1.1.0' && message.nervaConnectorUpdate === 'current') {
            record('current');
            process.exit(0);
        }
    });
    process.send({ nervaConnectorUpdate: 'check' });
}
`;
    }

    /** One signed native artifact uses the same exact size/hash commitments as production. */
    public async release(): Promise<ConnectorUpdateRelease> {
        const bytes: Buffer = await readFile(this.installer);
        return {
            version: '1.1.0',
            artifact: {
                name: this.installer.split('/').at(-1) ?? '',
                size: BigInt(bytes.length),
                sha256: createHash('sha256').update(bytes).digest('hex'),
            },
        };
    }

    /** The real downloader receives chunkable HTTPS responses through a bounded fixture transport only. */
    public async transport(): Promise<void> {
        const release: ConnectorUpdateRelease = await this.release();
        const manifest: Buffer = Buffer.from(
            JSON.stringify({
                product:
                    this.settings.platform === ConnectorUpdatePlatform.Linux
                        ? 'nerva-connector-linux'
                        : 'nerva-connector-macos',
                version: release.version,
                files: {
                    [this.settings.architecture]: {
                        name: release.artifact.name,
                        size: release.artifact.size.toString(),
                        sha256: release.artifact.sha256,
                    },
                },
            }),
        );
        const signature: Buffer = Buffer.from(
            sign('sha256', manifest, this.key.privateKey).toString('base64'),
        );
        const installer: Buffer = await readFile(this.installer);
        vi.stubGlobal(
            'fetch',
            (input: string | URL | Request, options?: RequestInit): Promise<Response> => {
                if (options?.signal?.aborted) {
                    return Promise.reject(new Error('Fixture update request aborted'));
                }
                const url: string =
                    typeof input === 'string'
                        ? input
                        : input instanceof URL
                          ? input.href
                          : input.url;
                if (url.endsWith('/latest.json')) {
                    return Promise.resolve(new Response(new Uint8Array(manifest)));
                }
                if (url.endsWith('/latest.json.sig')) {
                    return Promise.resolve(new Response(new Uint8Array(signature)));
                }
                if (url.endsWith('/' + release.artifact.name)) {
                    return Promise.resolve(new Response(new Uint8Array(installer)));
                }
                return Promise.resolve(new Response(null, { status: 404 }));
            },
        );
        await writeFile(join(this.directory, 'feed.json'), manifest, { mode: 0o600 });
        await writeFile(join(this.directory, 'feed.sig'), signature, { mode: 0o600 });
    }

    /** Fixture teardown restores fetch and removes only its own account/program/package files. */
    public async [Symbol.asyncDispose](): Promise<void> {
        vi.unstubAllGlobals();
        vi.unstubAllEnvs();
        await rm(this.directory, { recursive: true, force: true });
    }
}
