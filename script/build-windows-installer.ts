// SPDX-FileCopyrightText: 2026 Dacely <business@dacely.com>
// SPDX-License-Identifier: LicenseRef-Proprietary

import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdir, readdir, readFile, rm, stat } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { promisify } from 'node:util';
import { ConnectorWindowsInstaller } from './ConnectorWindowsInstaller.ts';
import {
    ConnectorWindowsArchitecture,
    ConnectorWindowsNodeRuntime,
    type ConnectorWindowsNodeFiles,
} from './ConnectorWindowsNodeRuntime.ts';
import {
    ConnectorWindowsUpdateFeed,
    type ConnectorWindowsUpdateConfiguration,
} from './ConnectorWindowsUpdateFeed.ts';

/**
 * Builds build/Nerva-Connector-Setup-<version>-<arch>.exe, the one file a Windows user downloads and runs.
 *
 * @remarks
 * Requires NSIS 3, plus the .NET Framework C# compiler on Windows or Mono's mcs on Linux/macOS. It builds the Windows
 * connector and its native helpers, adds the pinned official node.exe and its license, and compiles them into the
 * setup program. Earlier setup programs for the same architecture and every intermediate are removed; the Node
 * download stays cached in build/windows-installer/cache. When assets/windows/updates.json exists, installed copies
 * check its feed for updates signed by its key; without it they never look for updates.
 *
 * Usage: `npm run build:windows-installer` or `npm run build:windows-installer -- --arch arm64`.
 */
const supplied: readonly string[] = process.argv.slice(2);
if (!(supplied.length === 0 || (supplied.length === 2 && supplied[0] === '--arch'))) {
    throw new Error('Usage: build-windows-installer [--arch x64|arm64]');
}
const architecture: ConnectorWindowsArchitecture | undefined = Object.values(
    ConnectorWindowsArchitecture,
).find(
    (value: ConnectorWindowsArchitecture): boolean =>
        value === (supplied[1] ?? ConnectorWindowsArchitecture.X64),
);
if (architecture === undefined) {
    throw new Error('Choose --arch x64 or --arch arm64');
}
const manifest: unknown = JSON.parse(await readFile(resolve('package.json'), 'utf8'));
const version: unknown =
    typeof manifest === 'object' && manifest !== null ? Reflect.get(manifest, 'version') : null;
if (typeof version !== 'string' || !/^[0-9]+\.[0-9]+\.[0-9]+$/u.test(version)) {
    throw new Error('package.json needs a plain major.minor.patch version');
}
const updates: ConnectorWindowsUpdateConfiguration | null = await ConnectorWindowsUpdateFeed.read(
    resolve(ConnectorWindowsUpdateFeed.configuration),
);
const root: string = resolve('build/windows-installer');
const work: string = join(root, 'work');
const application: string = join(work, 'app');
const name: string = `Nerva-Connector-Setup-${version}-${architecture}.exe`;
const destination: string = resolve('build', name);
await rm(work, { recursive: true, force: true });
await mkdir(application, { recursive: true, mode: 0o700 });
try {
    await promisify(execFile)(
        process.execPath,
        [
            resolve('script/build-connector.ts'),
            '--windows',
            '--output',
            join(application, 'nerva-connector.mjs'),
        ],
        { maxBuffer: 1048576, timeout: 600000 },
    );
    const runtime: ConnectorWindowsNodeFiles = await ConnectorWindowsNodeRuntime.obtain(
        join(root, 'cache'),
        architecture,
    );
    await ConnectorWindowsInstaller.build({
        work: join(work, 'installer'),
        destination,
        version,
        architecture,
        updates:
            updates === null
                ? null
                : {
                      feedUrl: updates.feedUrl,
                      publicKeyXml: ConnectorWindowsUpdateFeed.publicKeyXml(updates.publicKey),
                  },
        files: [
            { name: 'node.exe', source: runtime.node },
            { name: 'NODE-LICENSE.txt', source: runtime.license },
            ...[
                'nerva-connector.mjs',
                'nerva-connector-host-worker.mjs',
                'nerva-connector-state.exe',
                'nerva-connector-state.json',
                'nerva-connector-host.exe',
                'nerva-connector-host.json',
                'THIRD-PARTY-NOTICES.txt',
            ].map((file: string): { name: string; source: string } => ({
                name: file,
                source: join(application, file),
            })),
        ],
    });
} finally {
    await rm(work, { recursive: true, force: true });
}
for (const entry of await readdir(resolve('build'))) {
    if (
        entry !== name &&
        entry.startsWith('Nerva-Connector-Setup-') &&
        entry.endsWith(`-${architecture}.exe`)
    ) {
        await rm(resolve('build', entry), { force: true });
    }
}
const bytes: Buffer = await readFile(destination);
process.stdout.write(
    JSON.stringify({
        setup: destination,
        bytes: (await stat(destination)).size,
        sha256: createHash('sha256').update(bytes).digest('hex'),
        node: ConnectorWindowsNodeRuntime.version,
        updates: updates?.feedUrl ?? null,
    }) + '\n',
);
