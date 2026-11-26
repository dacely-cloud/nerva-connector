// SPDX-FileCopyrightText: 2026 Dacely <business@dacely.com>
// SPDX-License-Identifier: LicenseRef-Proprietary

import { execFile } from 'node:child_process';
import { createPublicKey } from 'node:crypto';
import { mkdir, readFile, rm } from 'node:fs/promises';
import { resolve } from 'node:path';
import { promisify } from 'node:util';
import {
    ConnectorWindowsUpdateFeed,
    type ConnectorWindowsUpdateConfiguration,
} from './ConnectorWindowsUpdateFeed.ts';

/**
 * Builds the x64 and arm64 setup programs and the signed update feed in build/windows-update, ready to upload.
 *
 * @remarks
 * Upload every file in build/windows-update to the feed URL in assets/windows/updates.json, the setup programs
 * before latest.json and latest.json.sig, so no installed copy is offered a file that is not there yet. The key must
 * be the private half of the public key in that file; a different key is refused, because installed copies would
 * reject everything it signs.
 *
 * Usage: `npm run release:windows -- --key /secure/path/update-key.pem`
 */
const supplied: readonly string[] = process.argv.slice(2);
if (supplied.length !== 2 || supplied[0] !== '--key' || supplied[1] === undefined) {
    throw new Error('Usage: release-windows --key <private-key.pem>');
}
const configuration: ConnectorWindowsUpdateConfiguration | null =
    await ConnectorWindowsUpdateFeed.read(resolve(ConnectorWindowsUpdateFeed.configuration));
if (configuration === null) {
    throw new Error('Create the update key first: npm run create:windows-update-key');
}
const privateKey: string = await readFile(supplied[1], 'utf8');
if (
    createPublicKey(privateKey).export({ type: 'spki', format: 'pem' }) !==
    createPublicKey(configuration.publicKey).export({ type: 'spki', format: 'pem' })
) {
    throw new Error('This key does not match the public key in assets/windows/updates.json');
}
const manifest: unknown = JSON.parse(await readFile(resolve('package.json'), 'utf8'));
const version: unknown =
    typeof manifest === 'object' && manifest !== null ? Reflect.get(manifest, 'version') : null;
if (typeof version !== 'string') {
    throw new Error('package.json has no version');
}
for (const architecture of ['x64', 'arm64'] as const) {
    await promisify(execFile)(
        process.execPath,
        [resolve('script/build-windows-installer.ts'), '--arch', architecture],
        { maxBuffer: 1048576, timeout: 1200000 },
    );
}
const output: string = resolve('build/windows-update');
await rm(output, { recursive: true, force: true });
await mkdir(output, { recursive: true, mode: 0o755 });
await ConnectorWindowsUpdateFeed.write(
    output,
    version,
    (['x64', 'arm64'] as const).map((architecture: 'x64' | 'arm64') => ({
        architecture,
        path: resolve('build', `Nerva-Connector-Setup-${version}-${architecture}.exe`),
    })),
    privateKey,
);
process.stdout.write(
    JSON.stringify({ upload: output, feed: configuration.feedUrl, version }) + '\n',
);
