// SPDX-FileCopyrightText: 2026 Nerva contributors
// SPDX-License-Identifier: LicenseRef-Proprietary

import { lstat, readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { ConnectorUpdateManifest } from '../src/update/ConnectorUpdateManifest.ts';
import { ConnectorUpdatePaths } from '../src/update/ConnectorUpdatePaths.ts';
import {
    ConnectorUpdatePlatform,
    type ConnectorUpdateSetup,
} from '../src/update/ConnectorUpdateProtocol.ts';
import { ConnectorPosixUpdateFeed } from './ConnectorPosixUpdateFeed.ts';

/** Signs existing native CI artifacts without rebuilding or copying dependency trees; no signing key is sent to CI. */
const supplied: readonly string[] = process.argv.slice(2);
const options: Map<string, string> = new Map();
for (let index: number = 0; index < supplied.length; index += 2) {
    const option: string = supplied[index];
    const value: string | undefined = supplied[index + 1];
    if (
        !['--key', '--platform', '--artifacts-directory', '--output-directory'].includes(option) ||
        value === undefined ||
        options.has(option)
    ) {
        throw new Error(
            'Use release-posix --key PRIVATE_KEY --platform linux|darwin [--artifacts-directory BUILD] [--output-directory OUTPUT]',
        );
    }
    options.set(option, value);
}
const platform: ConnectorUpdatePlatform | undefined = Object.values(ConnectorUpdatePlatform).find(
    (value: ConnectorUpdatePlatform): boolean => value === options.get('--platform'),
);
const key: string | undefined = options.get('--key');
if (platform === undefined || key === undefined) {
    throw new Error('A private update key and explicit native platform are required');
}
const keyPath: string = resolve(key);
const status: Awaited<ReturnType<typeof lstat>> = await lstat(keyPath);
if (!status.isFile() || (status.mode & 0o077) !== 0 || status.size > 16384) {
    throw new Error('Update signing key must be a bounded owner-private regular file');
}
const privateKey: string = (await ConnectorUpdatePaths.read(keyPath, 16384)).toString('utf8');
const raw: unknown = JSON.parse(await readFile(resolve('package.json'), 'utf8'));
const version: string = ConnectorUpdateManifest.version(
    typeof raw === 'object' && raw !== null && 'version' in raw ? raw.version : null,
);
const artifacts: string = resolve(options.get('--artifacts-directory') ?? 'build');
const output: string = resolve(
    options.get('--output-directory') ?? `build/posix-update/${platform}`,
);
const setups: readonly ConnectorUpdateSetup[] = (['x64', 'arm64'] as const).map(
    (architecture: 'x64' | 'arm64'): ConnectorUpdateSetup => ({
        architecture,
        path: resolve(
            artifacts,
            `Nerva-Connector-Setup-${version}-${architecture}.${platform === ConnectorUpdatePlatform.Linux ? 'run' : 'dmg'}`,
        ),
    }),
);
await ConnectorPosixUpdateFeed.write(output, platform, version, setups, privateKey);
process.stdout.write(JSON.stringify({ upload: output, platform, version }) + '\n');
