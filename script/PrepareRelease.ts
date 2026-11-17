// SPDX-FileCopyrightText: 2026 Nerva contributors
// SPDX-License-Identifier: LicenseRef-Proprietary

import { join, resolve, relative, isAbsolute, sep } from 'node:path';
import { ProtectedFiles } from '../src/local/ProtectedFiles.ts';
import { SigningKey } from '../src/identity/SigningKey.ts';
import { SignaturePurpose } from 'nerva-connector-protocol/identity/IdentityFormat.js';
import {
    ConnectorReleaseProtocol,
    ConnectorReleaseArchitecture,
    ConnectorReleasePlatform,
    type ConnectorReleaseArtifact,
    type ConnectorReleaseManifest,
    type ConnectorSignedRelease,
} from '../src/install/ConnectorRelease.ts';
import { ConnectorReleaseCodec } from '../src/install/ConnectorReleaseCodec.ts';
import { ConnectorInstallerScript } from '../src/install/ConnectorInstallerScript.ts';
import {
    ConnectorAuthorityPin,
    type ConnectorTrustedAuthority,
} from '../src/runtime/ConnectorAuthorityPin.ts';
import { Boundary } from 'nerva-connector-protocol/protocol/Boundary.js';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { ConnectorNodeRuntime } from '../src/networking/ConnectorNodeRuntime.ts';
import { ConnectorNpmPackage } from './ConnectorNpmPackage.ts';
import { ConnectorReleaseAssets } from '../src/install/ConnectorReleaseAssets.ts';
import { ConnectorWindowsBootstrap } from '../src/install/ConnectorWindowsBootstrap.ts';
import { ConnectorBootstrapWindowsBuild } from './ConnectorBootstrapWindowsBuild.ts';
import { WindowsStateArtifactFile } from '../src/windows/WindowsStateArtifactFile.ts';
import type { WindowsStateArtifact } from '../src/windows/WindowsStateArtifact.ts';
import { WindowsStateOwner } from '../src/windows/WindowsStateOwner.ts';
import {
    ConnectorReleasePreparationArguments,
    type ConnectorReleasePreparationOptions,
} from './ConnectorReleasePreparationArguments.ts';
import { ConnectorReleaseSources } from './ConnectorReleaseSources.ts';
import { ConnectorReleasePublisher } from './ConnectorReleasePublisher.ts';
import {
    ConnectorPrivateDirectory,
    ConnectorDirectoryPurpose,
} from '../src/runtime/ConnectorPrivateDirectory.ts';

/** Reviewed public release output uses stable paths; the offline signing key is never copied to a release or customer host. */
const args: readonly string[] = process.argv.slice(2);
const options: ConnectorReleasePreparationOptions = ConnectorReleasePreparationArguments.read(args);
const stop: AbortController = new AbortController();
const interrupt: () => void = (): void => stop.abort();
process.once('SIGINT', interrupt);
process.once('SIGTERM', interrupt);
let summary: string | null = null;
try {
    const raw: unknown = JSON.parse(
        new TextDecoder('utf-8', { fatal: true }).decode(
            await ProtectedFiles.readPrivate(options.configuration, 16384),
        ),
    );
    const value: Readonly<Record<string, unknown>> = Boundary.record(raw, [
        'releaseId',
        'revision',
        'expiresAtMs',
        'platform',
        'releaseKeyFile',
        'nodeFile',
        'nodeLicenseFile',
        'authorityId',
        'authorityPublicKeyFile',
        'endpoints',
        'verificationUri',
        'serverCaFile',
        'downloadBaseUrl',
        'npmVersion',
    ]);
    const destination: string = options.destination ?? resolve('build');
    if (resolve(destination) !== destination) {
        throw new Error('Canonical publisher output directory required');
    }
    const platform: ConnectorReleasePlatform | undefined = Object.values(
        ConnectorReleasePlatform,
    ).find((entry: ConnectorReleasePlatform): boolean => entry === value['platform']);
    if (platform === undefined || platform.valueOf() !== process.platform) {
        throw new Error('Prepare the reviewed release on its declared operating system');
    }
    if (platform === ConnectorReleasePlatform.Windows && options.destination === null) {
        throw new Error(
            'Windows release preparation requires --output-directory with an existing native owner-private publisher directory',
        );
    }
    const npmVersion: string = ConnectorNpmPackage.version(value['npmVersion']);
    await ProtectedFiles.directory(destination);
    const releaseKeyFile: string = ProtectedFiles.path(value['releaseKeyFile']);
    const keyRelative: string = relative(destination, releaseKeyFile);
    if (keyRelative !== '..' && !keyRelative.startsWith('..' + sep) && !isAbsolute(keyRelative)) {
        throw new Error('Private release key must be outside release output');
    }
    using key: SigningKey = await loadSigningKey(releaseKeyFile);
    const authority: ConnectorTrustedAuthority = await ConnectorAuthorityPin.load(
        Boundary.id(value['authorityId']),
        ProtectedFiles.path(value['authorityPublicKeyFile']),
    );
    const sourcePlan: ConnectorReleaseSources = await ConnectorReleaseSources.read(
        {
            platform,
            directory: options.artifactsDirectory ?? destination,
            runtimeFile: ProtectedFiles.path(value['nodeFile']),
            licenseFile: ProtectedFiles.path(value['nodeLicenseFile']),
            privateKeyFile: releaseKeyFile,
        },
        stop.signal,
    );
    const artifacts: readonly ConnectorReleaseArtifact[] = sourcePlan.artifacts;
    const manifest: ConnectorReleaseManifest = {
        protocol: ConnectorReleaseProtocol.Current,
        releaseId: Boundary.id(value['releaseId']),
        revision: Boundary.integer(value['revision']),
        issuedAtMs: BigInt(Date.now()),
        expiresAtMs: Boundary.integer(value['expiresAtMs']),
        platform,
        architecture:
            process.arch === 'x64'
                ? ConnectorReleaseArchitecture.X64
                : process.arch === 'arm64'
                  ? ConnectorReleaseArchitecture.Arm64
                  : ((): never => {
                        throw new Error('Unsupported connector release architecture');
                    })(),
        artifacts,
        deployment: {
            authorityId: authority.authorityId,
            publicKey: authority.publicKey,
            endpoints: Boundary.array(value['endpoints'], 8).map((entry: unknown): string =>
                Boundary.text(entry),
            ),
            verificationUri: Boundary.text(value['verificationUri']),
            serverCaPem:
                value['serverCaFile'] === null
                    ? null
                    : (
                          await ProtectedFiles.readTrusted(
                              ProtectedFiles.path(value['serverCaFile']),
                              65536,
                              false,
                          )
                      ).toString('utf8'),
        },
    };
    const release: ConnectorSignedRelease = {
        manifest,
        signature: key.sign(SignaturePurpose.Release, ConnectorReleaseCodec.payload(manifest)),
    };
    const runtimeSource: string = sourcePlan.source(ConnectorReleaseAssets.runtime(platform));
    const runtimeVersion: Awaited<ReturnType<typeof execFile.__promisify__>> = await promisify(
        execFile,
    )(
        runtimeSource,
        [
            '--input-type=module',
            '--eval',
            'process.stdout.write(JSON.stringify({node:process.versions.node,undici:process.versions.undici,platform:process.platform,architecture:process.arch}))',
        ],
        {
            env: {
                ...(platform === ConnectorReleasePlatform.Windows
                    ? process.env
                    : { PATH: '/usr/bin:/bin' }),
                NODE_OPTIONS: '',
                NODE_PATH: '',
                NODE_EXTRA_CA_CERTS: '',
                NODE_TLS_REJECT_UNAUTHORIZED: '1',
            },
            timeout: 5000,
            maxBuffer: 1024,
            signal: stop.signal,
        },
    );
    const runtime: Readonly<Record<string, unknown>> = Boundary.record(
        JSON.parse(runtimeVersion.stdout.toString()),
        ['node', 'undici', 'platform', 'architecture'],
    );
    ConnectorNodeRuntime.validate(Boundary.text(runtime['node']), Boundary.text(runtime['undici']));
    if (runtime['platform'] !== platform || runtime['architecture'] !== manifest.architecture) {
        throw new Error(
            'Reviewed Node runtime does not match the signed release platform and architecture',
        );
    }
    const encoded: Buffer = ConnectorReleaseCodec.encode(release);
    ConnectorReleaseCodec.read(
        JSON.parse(encoded.toString('utf8')),
        key.publicKey,
        manifest.issuedAtMs,
    );
    const bootstrapDirectory: string =
        platform === ConnectorReleasePlatform.Windows
            ? await ConnectorReleaseSources.bootstrapDirectory(
                  options.artifactsDirectory ?? resolve('build'),
                  releaseKeyFile,
                  destination,
              )
            : resolve('build');
    stop.signal.throwIfAborted();
    const bootstrap: WindowsStateArtifact | null =
        platform === ConnectorReleasePlatform.Windows
            ? relative(bootstrapDirectory, destination) === ''
                ? await ConnectorBootstrapWindowsBuild.cached(bootstrapDirectory)
                : await ConnectorBootstrapWindowsBuild.build(bootstrapDirectory)
            : null;
    const script: string =
        platform === ConnectorReleasePlatform.Windows
            ? ConnectorWindowsBootstrap.command()
            : ConnectorInstallerScript.create(
                  release,
                  key.publicKey,
                  Boundary.text(value['downloadBaseUrl']),
              );
    const installerName: string =
        platform === ConnectorReleasePlatform.Windows
            ? 'install-connector.cmd'
            : 'install-connector.sh';
    const outputs: Map<string, Buffer> = new Map([
        ['release.json', encoded],
        [installerName, Buffer.from(script)],
    ]);
    if (platform === ConnectorReleasePlatform.Windows) {
        if (bootstrap === null) {
            throw new Error('Windows release requires a reviewed bootstrap executable');
        }
        outputs.set(
            'nerva-connector-bootstrap.exe',
            await WindowsStateArtifactFile.read(
                join(bootstrapDirectory, 'nerva-connector-bootstrap.exe'),
                bootstrap,
            ),
        );
        outputs.set(
            'release-bootstrap.json',
            Buffer.from(
                JSON.stringify(
                    ConnectorWindowsBootstrap.configuration(
                        release,
                        key.publicKey,
                        Boundary.text(value['downloadBaseUrl']),
                    ),
                ) + '\n',
            ),
        );
    }
    {
        await using owner: ConnectorPrivateDirectory = await ConnectorPrivateDirectory.open(
            destination,
            ConnectorDirectoryPurpose.Installation,
        );
        await sourcePlan.promote(owner, stop.signal);
        for (const [name, bytes] of outputs) {
            stop.signal.throwIfAborted();
            if (
                name === 'nerva-connector-bootstrap.exe' &&
                relative(bootstrapDirectory, destination) === ''
            ) {
                if (!(await owner.read(name, 262144)).equals(bytes)) {
                    throw new Error('Private publisher bootstrap changed before verification');
                }
                continue;
            }
            await ConnectorReleasePublisher.write(owner, name, bytes);
        }
        for (const name of [
            'install-connector.sh',
            'install-connector.cmd',
            'release-bootstrap.json',
            'nerva-connector-bootstrap.json',
        ]) {
            if (
                name === 'nerva-connector-bootstrap.json' &&
                relative(bootstrapDirectory, destination) === ''
            ) {
                continue;
            }
            if (!outputs.has(name)) {
                await owner.cleanPartial(name, 131072);
                if (await owner.exists(name)) {
                    await owner.remove(name, 131072);
                }
            }
        }
    }
    const npmDirectory: string = await ConnectorNpmPackage.prepare(
        join(destination, 'npm'),
        npmVersion,
        release,
        key.publicKey,
        Boundary.text(value['downloadBaseUrl']),
        bootstrapDirectory,
        bootstrap,
        stop.signal,
    );
    summary =
        JSON.stringify({
            releaseId: manifest.releaseId,
            revision: manifest.revision.toString(),
            artifacts: artifacts.map((entry): string => entry.name),
            installer: join(destination, installerName),
            npmDirectory,
        }) + '\n';
} finally {
    process.removeListener('SIGINT', interrupt);
    process.removeListener('SIGTERM', interrupt);
    await WindowsStateOwner.close();
}
if (summary !== null) {
    process.stdout.write(summary);
}

/** The offline release key is decoded only on the trusted publisher, and its serialized secret buffer is cleared. */
async function loadSigningKey(path: string): Promise<SigningKey> {
    const bytes: Buffer = await ProtectedFiles.readPrivate(path, 1024);
    try {
        return SigningKey.decode(bytes);
    } finally {
        bytes.fill(0);
    }
}
