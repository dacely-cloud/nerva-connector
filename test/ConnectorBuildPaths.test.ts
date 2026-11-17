// SPDX-FileCopyrightText: 2026 Nerva contributors
// SPDX-License-Identifier: LicenseRef-Proprietary

import { posix, win32, join } from 'node:path';
import { mkdtemp, readdir, rm } from 'node:fs/promises';
import { homedir } from 'node:os';
import { createHash } from 'node:crypto';
import { expect, it } from 'vitest';
import { ConnectorBuildPaths } from '../script/ConnectorBuildPaths.js';
import { ConnectorBuildArtifact } from '../script/ConnectorBuildArtifact.js';
import { ConnectorReleaseArtifacts } from '../src/install/ConnectorReleaseArtifacts.js';
import {
    ConnectorReleaseFile,
    type ConnectorReleaseArtifact,
} from '../src/install/ConnectorRelease.js';

it('custom Windows and POSIX build layouts select the mandatory adjacent release notices without an application-name alias', (): void => {
    expect(ConnectorBuildPaths.notices('C:\\ProtectedPublisher\\connector.mjs', win32)).toBe(
        win32.join('C:\\ProtectedPublisher', ConnectorReleaseFile.Notices),
    );
    expect(ConnectorBuildPaths.notices('/protected/publisher/connector.mjs', posix)).toBe(
        posix.join('/protected/publisher', ConnectorReleaseFile.Notices),
    );
    for (const invalid of ['connector.mjs', '/protected/publisher/app.js']) {
        expect((): string => ConnectorBuildPaths.notices(invalid, posix)).toThrow();
    }
});

it.skipIf(process.platform !== 'linux')(
    'custom-output notices published by the real artifact writer are consumed and verified by the release reader',
    async (): Promise<void> => {
        const directory: string = await mkdtemp(join(homedir(), 'nerva-notices-layout-'));
        try {
            const notices: Buffer = Buffer.from('Isolated release-notices fixture.\n');
            await ConnectorBuildArtifact.publish(
                ConnectorBuildPaths.notices(join(directory, 'connector.mjs')),
                notices,
                0o600,
            );
            const artifact: ConnectorReleaseArtifact = await ConnectorReleaseArtifacts.describe(
                join(directory, ConnectorReleaseFile.Notices),
                ConnectorReleaseFile.Notices,
                new AbortController().signal,
            );
            expect(artifact).toEqual({
                name: ConnectorReleaseFile.Notices,
                sizeBytes: BigInt(notices.length),
                sha256: createHash('sha256').update(notices).digest('hex'),
            });
            await ConnectorReleaseArtifacts.verify(
                directory,
                artifact,
                new AbortController().signal,
            );
            expect(await readdir(directory)).toEqual([ConnectorReleaseFile.Notices]);
        } finally {
            await rm(directory, { recursive: true, force: true });
        }
    },
);

it('Windows module auditing accepts native and bundler slash paths on the same drive or UNC share', (): void => {
    for (const file of [
        'C:\\work\\nerva\\src\\cli\\Main.ts',
        'C:/work/nerva/src/cli/Main.ts',
        'c:/WORK/NERVA/src/cli/Main.ts',
    ]) {
        expect(ConnectorBuildPaths.contains('C:\\work\\nerva\\src', file, win32)).toBe(true);
    }
    expect(
        ConnectorBuildPaths.contains(
            '\\\\server\\share\\nerva\\src',
            '//server/share/nerva/src/Main.ts',
            win32,
        ),
    ).toBe(true);
});

it('Windows source checks still refuse sibling trees, escaped paths, other drives/shares and relative IDs', (): void => {
    for (const file of [
        'C:/work/nerva/src-foreign/Main.ts',
        'C:/work/nerva/src/../../nexa/Main.ts',
        'D:/work/nerva/src/Main.ts',
        'src/Main.ts',
        'C:Main.ts',
        'C:/work/nerva/src',
    ]) {
        expect(ConnectorBuildPaths.contains('C:\\work\\nerva\\src', file, win32)).toBe(false);
    }
    expect(
        ConnectorBuildPaths.contains(
            '\\\\server\\share\\nerva\\src',
            '//server/other/nerva/src/Main.ts',
            win32,
        ),
    ).toBe(false);
});

it('POSIX builds preserve the same source and reviewed-dependency boundaries', (): void => {
    expect(
        ConnectorBuildPaths.contains('/work/connector/src', '/work/connector/src/Main.ts', posix),
    ).toBe(true);
    expect(
        ConnectorBuildPaths.contains(
            '/work/connector/node_modules/@noble/hashes',
            '/work/connector/node_modules/@noble/hashes/sha2.js',
            posix,
        ),
    ).toBe(true);
    for (const file of [
        '/work/connector/src-other/Main.ts',
        '/work/connector/src/../controller/Main.ts',
        'src/Main.ts',
    ]) {
        expect(ConnectorBuildPaths.contains('/work/connector/src', file, posix)).toBe(false);
    }
});
