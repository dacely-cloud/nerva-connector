// SPDX-FileCopyrightText: 2026 Dacely <business@dacely.com>
// SPDX-License-Identifier: LicenseRef-Proprietary

import { execFile } from 'node:child_process';
import { mkdir } from 'node:fs/promises';
import { resolve } from 'node:path';
import { promisify } from 'node:util';
import { ConnectorWindowsQualificationBuild } from './ConnectorWindowsQualificationBuild.ts';
import type { WindowsQualificationArtifacts } from './ConnectorWindowsQualificationBuild.ts';

const arguments_: readonly string[] = process.argv.slice(2);
if (arguments_.length > 1 || (arguments_.length === 1 && arguments_[0] !== '--run')) {
    throw new Error(
        'Use no arguments to cross-compile, or --run on Windows to qualify native confinement',
    );
}
if (arguments_.length === 1 && process.platform !== 'win32') {
    throw new Error(
        'Native token, NTFS and job qualification requires Windows; compilation is not runtime evidence',
    );
}
const directory: string = resolve('build');
await mkdir(directory, { recursive: true, mode: 0o700 });
const artifacts: WindowsQualificationArtifacts =
    await ConnectorWindowsQualificationBuild.build(directory);
if (arguments_.length === 0) {
    process.stdout.write(
        JSON.stringify({ compiled: true, runtimeQualified: false, ...artifacts }) + '\n',
    );
} else {
    const output: Awaited<ReturnType<typeof execFile.__promisify__>> = await promisify(execFile)(
        resolve(directory, 'nerva-connector-files-qualification.exe'),
        ['--qualify'],
        { timeout: 30000, maxBuffer: 4096, windowsHide: true },
    );
    process.stdout.write(output.stdout);
}
