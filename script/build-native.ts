// SPDX-FileCopyrightText: 2026 Dacely <business@dacely.com>
// SPDX-License-Identifier: LicenseRef-Proprietary

import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { isAbsolute, resolve, join } from 'node:path';
import { readFile, mkdir, stat } from 'node:fs/promises';
import { ConnectorBuildArtifact } from './ConnectorBuildArtifact.ts';
import { createHash } from 'node:crypto';

/**
 * Reuses an operator-selected existing Cargo target and copies only the intentional helper executables.
 *
 * @remarks
 * Linux builds the confined file, execution/terminal and atomic update helpers. macOS builds the
 * terminal and atomic update helpers; confined execution lanes depend on Linux kernel features.
 */
const configuredTarget: string | undefined = process.env['CARGO_TARGET_DIR'];
if (
    (process.platform !== 'linux' && process.platform !== 'darwin') ||
    configuredTarget === undefined
) {
    throw new Error(
        'Set CARGO_TARGET_DIR to an existing reusable target directory on Linux or macOS',
    );
}
const helpers: readonly string[] =
    process.platform === 'linux'
        ? ['nerva-connector-files', 'nerva-connector-exec', 'nerva-connector-update']
        : ['nerva-connector-exec', 'nerva-connector-update'];
if (
    configuredTarget.length === 0 ||
    !configuredTarget.isWellFormed() ||
    configuredTarget.length > 4096 ||
    configuredTarget
        .split('')
        .some(
            (character: string): boolean =>
                character.charCodeAt(0) < 32 || character.charCodeAt(0) === 127,
        ) ||
    !isAbsolute(configuredTarget)
) {
    throw new Error('CARGO_TARGET_DIR must be a bounded absolute path without control characters');
}
const target: string = resolve(configuredTarget);
if (!(await stat(target)).isDirectory()) {
    throw new Error('CARGO_TARGET_DIR must select an existing reusable directory');
}
await promisify(execFile)(
    'cargo',
    [
        'build',
        '--locked',
        '--release',
        '--manifest-path',
        resolve('native/Cargo.toml'),
        ...helpers.flatMap((name: string): readonly string[] => ['--bin', name]),
    ],
    {
        cwd: resolve('.'),
        env: { ...process.env, CARGO_TARGET_DIR: target },
        timeout: 300000,
        maxBuffer: 65536,
    },
);
await mkdir(resolve('build'), { recursive: true, mode: 0o700 });
for (const name of helpers) {
    const destination: string = resolve('build', name);
    const bytes: Buffer = await readFile(join(target, 'release', name));
    await ConnectorBuildArtifact.publish(destination, bytes, 0o700);
    if (name === 'nerva-connector-exec') {
        await ConnectorBuildArtifact.publish(
            destination + '.json',
            JSON.stringify({
                bytes: bytes.byteLength,
                sha256: createHash('sha256').update(bytes).digest('hex'),
            }) + '\n',
            0o600,
        );
    }
    process.stdout.write(JSON.stringify({ artifact: destination }) + '\n');
}
