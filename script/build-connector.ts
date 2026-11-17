// SPDX-FileCopyrightText: 2026 Nerva contributors
// SPDX-License-Identifier: LicenseRef-Proprietary

import { rolldown, type RolldownBuild, type OutputChunk, type OutputAsset } from 'rolldown';
import { isBuiltin } from 'node:module';
import { mkdir, readFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { ConnectorBuildNotices } from './ConnectorBuildNotices.ts';
import { ConnectorBuildPaths } from './ConnectorBuildPaths.ts';
import { ConnectorBuildArtifact } from './ConnectorBuildArtifact.ts';
import { ConnectorWindowsArtifact } from './ConnectorWindowsArtifact.ts';
import { ConnectorWindowsBuild } from './ConnectorWindowsBuild.ts';
import { ConnectorHostWindowsBuild } from './ConnectorHostWindowsBuild.ts';
import { ConnectorHostWorkerBuild } from './ConnectorHostWorkerBuild.ts';
import { WindowsStateArtifactFile } from '../src/windows/WindowsStateArtifactFile.ts';
import type { WindowsStateArtifact } from '../src/windows/WindowsStateArtifact.ts';
import { ConnectorReleaseLimits } from '../src/install/ConnectorReleaseLimits.ts';
import { ConnectorLinuxArtifact } from './ConnectorLinuxArtifact.ts';
import { HostLinuxBuild } from '../src/host/HostLinuxBuild.ts';

import { CircularDependencies } from './CircularDependencies.ts';

CircularDependencies.check();

/** Builds one deliberate communication artifact in memory; no installed SDK, controller source or dependency tree is copied. */
const supplied: readonly string[] = process.argv.slice(2);
const windows: boolean = process.platform === 'win32' || supplied.includes('--windows');
if (supplied.filter((argument: string): boolean => argument === '--windows').length > 1) {
    throw new Error('Windows build target may be selected only once');
}
const args: readonly string[] = supplied.filter(
    (argument: string): boolean => argument !== '--windows',
);
if (args.length !== 0 && (args.length !== 2 || args[0] !== '--output' || args[1] === undefined)) {
    throw new Error(
        'Use --output with an owned connector artifact path, or no arguments for build/nerva-connector.mjs',
    );
}
const destination: string = resolve(args[1] ?? 'build/nerva-connector.mjs');
if (!destination.endsWith('.mjs')) {
    throw new Error('Connector artifacts require an explicit .mjs destination');
}
if (args.length === 0) {
    await mkdir(dirname(destination), { recursive: true, mode: 0o700 });
}
await ConnectorHostWorkerBuild.build(
    resolve(dirname(destination), 'nerva-connector-host-worker.mjs'),
);
const packages: readonly string[] = [
    '@dacely/noble-post-quantum',
    '@noble/hashes',
    '@noble/curves',
    'nerva-connector-protocol',
];
const licenses: string[] = [];
const shebang: string = '#!/usr/bin/env node\n';
const noticeTarget: string = ConnectorBuildNotices.target(
    windows ? 'win32' : process.platform,
    process.arch,
);
const [noticeBytes, lockBytes]: readonly [Buffer, Buffer] = await Promise.all([
    readFile(resolve('native', ConnectorBuildNotices.file(noticeTarget))),
    readFile(resolve('native/Cargo.lock')),
]);
const nativeNotices: string = ConnectorBuildNotices.prepare(noticeBytes, lockBytes, noticeTarget);
for (const name of packages) {
    const license: string = await readFile(resolve('node_modules', name, 'LICENSE'), 'utf8');
    if (license.includes('*/')) {
        throw new Error('Unsupported embedded cryptographic license');
    }
    licenses.push('/** ' + name + ' license:\n' + license + '\n*/');
}
let windowsArtifact: WindowsStateArtifact | null = null;
let hostArtifact: WindowsStateArtifact | null = null;
if (windows) {
    const nativeDirectory: string = resolve('build');
    await mkdir(nativeDirectory, { recursive: true, mode: 0o700 });
    windowsArtifact = await ConnectorWindowsBuild.build(nativeDirectory);
    hostArtifact = await ConnectorHostWindowsBuild.build(nativeDirectory);
    if (dirname(destination) !== nativeDirectory) {
        const bytes: Buffer = await WindowsStateArtifactFile.read(
            resolve(nativeDirectory, 'nerva-connector-state.exe'),
            windowsArtifact,
        );
        await ConnectorBuildArtifact.publish(
            resolve(dirname(destination), 'nerva-connector-state.exe'),
            bytes,
            0o700,
        );
        await ConnectorBuildArtifact.publish(
            resolve(dirname(destination), 'nerva-connector-state.json'),
            JSON.stringify(windowsArtifact) + '\n',
            0o600,
        );
        await ConnectorBuildArtifact.publish(
            resolve(dirname(destination), 'nerva-connector-host.exe'),
            await WindowsStateArtifactFile.read(
                resolve(nativeDirectory, 'nerva-connector-host.exe'),
                hostArtifact,
            ),
            0o700,
        );
        await ConnectorBuildArtifact.publish(
            resolve(dirname(destination), 'nerva-connector-host.json'),
            JSON.stringify(hostArtifact) + '\n',
            0o600,
        );
    }
}
const bundle: RolldownBuild = await rolldown({
    input: resolve('src/cli/Main.ts'),
    platform: 'node',
    plugins: [
        ConnectorWindowsArtifact.plugin(windowsArtifact, hostArtifact),
        ConnectorLinuxArtifact.plugin(windows ? null : await HostLinuxBuild.read()),
    ],
    external: (id: string): boolean => isBuiltin(id),
});
try {
    const result: Awaited<ReturnType<RolldownBuild['generate']>> = await bundle.generate({
        format: 'esm',
        codeSplitting: false,
        sourcemap: false,
        minify: true,
        banner: shebang,
    });
    if (result.output.length !== 1) {
        throw new Error('Connector artifact must be one self-contained communication module');
    }
    const chunk: OutputChunk | OutputAsset | undefined = result.output[0];
    if (chunk === undefined || chunk.type !== 'chunk' || !chunk.code.startsWith(shebang)) {
        throw new Error('Connector artifact is missing its native Node entry point');
    }
    const code: string = shebang + licenses.join('\n') + '\n' + chunk.code.slice(shebang.length);
    const artifactBytes: number = Buffer.byteLength(code);
    if (artifactBytes > ConnectorReleaseLimits.applicationBytes) {
        throw new Error(
            'Connector communication artifact is ' +
                artifactBytes.toString() +
                ' bytes; maximum is ' +
                ConnectorReleaseLimits.applicationBytes.toString(),
        );
    }
    if (
        !chunk.imports.every((id: string): boolean => isBuiltin(id)) ||
        chunk.dynamicImports.length !== 0
    ) {
        throw new Error('Connector artifact must depend only on the Node runtime');
    }
    for (const moduleId of Object.keys(chunk.modules)) {
        if (moduleId.startsWith('\0')) {
            continue;
        }
        if (
            !ConnectorBuildPaths.contains(resolve('src'), moduleId) &&
            !packages.some((name: string): boolean =>
                ConnectorBuildPaths.contains(resolve('node_modules', name), moduleId),
            )
        ) {
            throw new Error('Unexpected module in standalone connector communication artifact');
        }
    }

    await ConnectorBuildArtifact.publish(destination, code, 0o700);
    await ConnectorBuildArtifact.publish(
        ConnectorBuildPaths.notices(destination),
        nativeNotices,
        0o600,
    );
    process.stdout.write(
        JSON.stringify({
            artifactBytes,
            modules: Object.keys(chunk.modules).length,
        }) + '\n',
    );
} finally {
    await bundle.close();
}
