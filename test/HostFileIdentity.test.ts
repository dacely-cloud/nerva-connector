// SPDX-FileCopyrightText: 2026 Nerva contributors
// SPDX-License-Identifier: LicenseRef-Proprietary

import type { BigIntStats } from 'node:fs';
import { writeFile, stat, link, symlink, utimes } from 'node:fs/promises';
import { join } from 'node:path';
import { setTimeout } from 'node:timers/promises';
import { expect, it } from 'vitest';
import type { HostFileMetadata } from '../src/host/HostWorkspaceTypes.js';
import { HostWorkspaceFixture } from './support/HostWorkspaceFixture.js';

/** The public identity contract uses exact OS metadata and never mutable path spellings. */
function expectedIdentity(metadata: BigIntStats): string {
    return (
        'host-file-v1:' +
        metadata.dev.toString() +
        ':' +
        metadata.ino.toString() +
        ':' +
        metadata.birthtimeNs.toString() +
        ':' +
        metadata.ctimeNs.toString()
    );
}

it('host file identity reflects actual exact stat metadata and detects replacement at the same path', async (): Promise<void> => {
    await using fixture: HostWorkspaceFixture = await HostWorkspaceFixture.create();
    const original: string = join(fixture.directory, 'original.txt');
    const replacement: string = join(fixture.directory, 'replacement.txt');
    await writeFile(original, 'same bytes');
    await writeFile(replacement, 'same bytes');
    const before: HostFileMetadata = await fixture.host.stat(original);
    expect(before.identity).toBe(expectedIdentity(await stat(original, { bigint: true })));
    expect((await fixture.host.stat(original)).identity).toBe(before.identity);
    await fixture.host.rename(replacement, original);
    const after: HostFileMetadata = await fixture.host.stat(original);
    expect(after.size).toBe(before.size);
    expect(after.identity).not.toBe(before.identity);
    expect(after.identity).toBe(expectedIdentity(await stat(original, { bigint: true })));
});

it('mtime-restored in-place edits retain inode identity but change the actual ctime metadata token', async (): Promise<void> => {
    await using fixture: HostWorkspaceFixture = await HostWorkspaceFixture.create();
    const path: string = join(fixture.directory, 'edited.txt');
    await writeFile(path, 'abcd');
    await utimes(path, 1234567890, 1234567890);
    const before: HostFileMetadata = await fixture.host.stat(path);
    const beforeStat: BigIntStats = await stat(path, { bigint: true });
    await setTimeout(20);
    await writeFile(path, 'wxyz');
    await utimes(path, 1234567890, 1234567890);
    const after: HostFileMetadata = await fixture.host.stat(path);
    const afterStat: BigIntStats = await stat(path, { bigint: true });
    expect(after.size).toBe(before.size);
    expect(after.modifiedAtNs).toBe(before.modifiedAtNs);
    expect(afterStat.ino).toBe(beforeStat.ino);
    expect(after.identity).not.toBe(before.identity);
    expect(after.identity).toBe(expectedIdentity(afterStat));
});

it('hard-link spellings share the same observed file metadata identity', async (): Promise<void> => {
    await using fixture: HostWorkspaceFixture = await HostWorkspaceFixture.create();
    const source: string = join(fixture.directory, 'source.txt');
    const alias: string = join(fixture.directory, 'alias.txt');
    await writeFile(source, 'linked contents');
    await link(source, alias);
    expect((await fixture.host.stat(alias)).identity).toBe(
        (await fixture.host.stat(source)).identity,
    );
});

it.skipIf(process.platform === 'win32')(
    'explicit stat following identifies the symlink target while default stat identifies the link',
    async (): Promise<void> => {
        await using fixture: HostWorkspaceFixture = await HostWorkspaceFixture.create();
        const target: string = join(fixture.directory, 'target.txt');
        const symbolic: string = join(fixture.directory, 'symbolic.txt');
        await writeFile(target, 'target contents');
        await symlink(target, symbolic);
        const direct: HostFileMetadata = await fixture.host.stat(target);
        expect((await fixture.host.stat(symbolic, true)).identity).toBe(direct.identity);
        expect((await fixture.host.stat(symbolic)).identity).not.toBe(direct.identity);
    },
);
