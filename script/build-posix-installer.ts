// SPDX-FileCopyrightText: 2026 Dacely <business@dacely.com>
// SPDX-License-Identifier: LicenseRef-Proprietary

import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import { lstat, mkdir, readFile, readdir, rm } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { promisify } from 'node:util';
import { ConnectorNativeFormat } from '../src/runtime/ConnectorNativeFormat.ts';
import { HostLinuxBuild } from '../src/host/HostLinuxBuild.ts';
import type { HostLinuxArtifact } from '../src/host/HostLinuxArtifact.ts';
import { ConnectorBuildArtifact } from './ConnectorBuildArtifact.ts';
import { ConnectorLinuxInstaller } from './ConnectorLinuxInstaller.ts';
import { ConnectorMacInstaller } from './ConnectorMacInstaller.ts';
import { ConnectorPosixNodeRuntime } from './ConnectorPosixNodeRuntime.ts';
import { ConnectorPosixArchitecture, ConnectorPosixPlatform } from './ConnectorPosixPlatform.ts';
import { ConnectorPosixUpdateBuild } from './ConnectorPosixUpdateBuild.ts';

/** Builds one native, self-contained desktop installer without copying installed dependencies or Cargo caches. */
const supplied: readonly string[] = process.argv.slice(2);
const platform: ConnectorPosixPlatform | undefined = Object.values(ConnectorPosixPlatform).find(
    (value: ConnectorPosixPlatform): boolean => value === supplied[1],
);
const architecture: ConnectorPosixArchitecture | undefined = Object.values(
    ConnectorPosixArchitecture,
).find((value: ConnectorPosixArchitecture): boolean => value === process.arch);
if (
    supplied.length !== 2 ||
    supplied[0] !== '--platform' ||
    platform === undefined ||
    platform !== process.platform ||
    architecture === undefined
) {
    throw new Error(
        'Use build-posix-installer --platform linux|darwin on that native operating system (x64 or arm64)',
    );
}
const raw: unknown = JSON.parse(await readFile(resolve('package.json'), 'utf8'));
const version: unknown =
    typeof raw === 'object' && raw !== null ? Reflect.get(raw, 'version') : null;
if (typeof version !== 'string' || !/^[0-9]+\.[0-9]+\.[0-9]+$/u.test(version)) {
    throw new Error('Installer builds require a plain major.minor.patch version');
}
const helper: HostLinuxArtifact | null = await HostLinuxBuild.read();
if (helper === null) {
    throw new Error('Build the native helpers with npm run build:native before packaging');
}
const stop: AbortController = new AbortController();
const interrupt: () => void = (): void => stop.abort();
process.once('SIGINT', interrupt);
process.once('SIGTERM', interrupt);
const root: string = resolve('build/posix-installer');
const work: string = join(root, `work-${platform}-${architecture}`);
const extension: string = platform === ConnectorPosixPlatform.Linux ? 'run' : 'dmg';
const name: string = `Nerva-Connector-Setup-${version}-${architecture}.${extension}`;
const destination: string = resolve('build', name);
await mkdir(root, { recursive: true, mode: 0o700 });
await mkdir(work, { mode: 0o700 });
try {
    const application: string =
        platform === ConnectorPosixPlatform.Mac
            ? await ConnectorMacInstaller.application(work, version, stop.signal)
            : join(work, 'app');
    await mkdir(application, { recursive: true, mode: 0o700 });
    const nativeNames: readonly string[] =
        platform === ConnectorPosixPlatform.Linux
            ? ['nerva-connector-exec', 'nerva-connector-files', 'nerva-connector-update']
            : ['nerva-connector-exec', 'nerva-connector-update'];
    for (const file of nativeNames) {
        const source: string = resolve('build', file);
        const status: Awaited<ReturnType<typeof lstat>> = await lstat(source);
        if (!status.isFile() || status.size < 64 || status.size > 16777216) {
            throw new Error('Native helper must be a bounded regular build artifact');
        }
        const bytes: Buffer = await readFile(source);
        const digest: string = createHash('sha256').update(bytes).digest('hex');
        if (
            file === 'nerva-connector-exec' &&
            (digest !== helper.sha256 || bytes.byteLength !== helper.bytes)
        ) {
            throw new Error('Native helper differs from its build commitment');
        }
        if (
            bytes.byteLength > 16777216 ||
            !ConnectorNativeFormat.matches(bytes, platform, architecture)
        ) {
            throw new Error(
                'Native helper must be built for this installer operating system and architecture',
            );
        }
        await ConnectorBuildArtifact.publish(join(application, file), bytes, 0o700);
    }
    await ConnectorPosixNodeRuntime.obtain(
        join(root, 'cache'),
        application,
        platform,
        architecture,
        stop.signal,
    );
    await promisify(execFile)(
        process.execPath,
        [
            resolve('script/build-connector.ts'),
            '--output',
            join(application, 'nerva-connector.mjs'),
        ],
        {
            timeout: 600000,
            maxBuffer: 1048576,
            signal: stop.signal,
        },
    );
    await ConnectorBuildArtifact.publish(
        join(application, 'nerva-connector'),
        await readFile(resolve('assets/posix/nerva-connector')),
        0o700,
    );
    await ConnectorPosixUpdateBuild.build(
        join(application, 'nerva-connector-update.mjs'),
        await ConnectorPosixUpdateBuild.settings(
            platform,
            architecture,
            version,
            createHash('sha256')
                .update(await readFile(join(application, 'nerva-connector-update')))
                .digest('hex'),
        ),
    );
    const runtime: Awaited<ReturnType<typeof execFile.__promisify__>> = await promisify(execFile)(
        join(application, 'node'),
        [
            '--input-type=module',
            '-e',
            'process.stdout.write(JSON.stringify({platform:process.platform,architecture:process.arch,node:process.versions.node}))',
        ],
        {
            timeout: 10000,
            maxBuffer: 1024,
            signal: stop.signal,
            env: {
                PATH: '/usr/bin:/bin',
                NODE_OPTIONS: '',
                NODE_PATH: '',
                NODE_EXTRA_CA_CERTS: '',
                NODE_TLS_REJECT_UNAUTHORIZED: '1',
            },
        },
    );
    const expected: string = JSON.stringify({
        platform,
        architecture,
        node: ConnectorPosixNodeRuntime.version,
    });
    if (runtime.stdout !== expected) {
        throw new Error('Bundled runtime does not match the native package target');
    }
    await promisify(execFile)(join(application, 'nerva-connector'), ['--help'], {
        timeout: 10000,
        maxBuffer: 65536,
        signal: stop.signal,
    });
    if (platform === ConnectorPosixPlatform.Linux) {
        await ConnectorBuildArtifact.publish(
            join(application, 'nerva-connector-logo.png'),
            await readFile(resolve('assets/windows/nerva-connector-logo.png')),
            0o600,
        );
        await ConnectorBuildArtifact.publish(
            join(application, '.nerva-installation'),
            'nerva-connector-linux-v1\n',
            0o600,
        );
        await ConnectorLinuxInstaller.build(application, destination, architecture, stop.signal);
    } else {
        await ConnectorMacInstaller.build(work, destination, stop.signal);
    }
    const bytes: Buffer = await readFile(destination);
    const sha256: string = createHash('sha256').update(bytes).digest('hex');
    await ConnectorBuildArtifact.publish(destination + '.sha256', `${sha256}  ${name}\n`, 0o600);
    for (const entry of await readdir(resolve('build'))) {
        if (
            entry !== name &&
            entry !== name + '.sha256' &&
            /^Nerva-Connector-Setup-[0-9]+\.[0-9]+\.[0-9]+-/u.test(entry) &&
            (entry.endsWith(`-${architecture}.${extension}`) ||
                entry.endsWith(`-${architecture}.${extension}.sha256`))
        ) {
            await rm(resolve('build', entry));
        }
    }
    process.stdout.write(
        JSON.stringify({
            installer: destination,
            bytes: bytes.byteLength,
            sha256,
            platform,
            architecture,
            node: ConnectorPosixNodeRuntime.version,
        }) + '\n',
    );
} finally {
    await rm(work, { recursive: true, force: true });
    process.off('SIGINT', interrupt);
    process.off('SIGTERM', interrupt);
}
