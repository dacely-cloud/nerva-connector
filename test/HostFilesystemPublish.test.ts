// SPDX-FileCopyrightText: 2026 Dacely <business@dacely.com>
// SPDX-License-Identifier: LicenseRef-Proprietary

import type { BigIntStats, PathLike } from 'node:fs';
import { writeFile, readFile, stat, symlink } from 'node:fs/promises';
import { join } from 'node:path';
import { expect, it, vi } from 'vitest';
import { ConnectorHostErrorCode } from 'nerva-connector-protocol/protocol/ConnectorHost.js';
import { HostOperationError } from '../src/host/HostOperationError.js';
import { HostFileKind, HostOperation } from '../src/host/HostWorkspaceTypes.js';
import { HostWorkspaceFixture } from './support/HostWorkspaceFixture.js';

/** A targeted OS cleanup failure occurs only after the real atomic hard link has been installed. */
interface HostPublishFaults {
    source: string | null;
}

const faults: HostPublishFaults = vi.hoisted((): HostPublishFaults => ({ source: null }));

vi.mock(
    'node:fs/promises',
    async (
        original: () => Promise<typeof import('node:fs/promises')>,
    ): Promise<typeof import('node:fs/promises')> => {
        const actual: typeof import('node:fs/promises') = await original();
        return {
            ...actual,
            unlink: async (path: PathLike): Promise<void> => {
                if (path === faults.source) {
                    throw new Error('Injected source unlink failure');
                }
                await actual.unlink(path);
            },
        };
    },
);

it('publish atomically refuses overwrite, preserves file identity and authorizes both endpoints', async (): Promise<void> => {
    await using fixture: HostWorkspaceFixture = await HostWorkspaceFixture.create();
    const source: string = join(fixture.directory, 'stage.bin');
    const destination: string = join(fixture.directory, 'final.bin');
    await writeFile(source, 'complete publication');
    const original: BigIntStats = await stat(source, { bigint: true });
    await fixture.host.publish(source, destination);
    expect(await readFile(destination, 'utf8')).toBe('complete publication');
    expect((await stat(destination, { bigint: true })).ino).toBe(original.ino);
    await expect(stat(source)).rejects.toThrow();
    expect(fixture.checks).toContainEqual({
        operation: HostOperation.Publish,
        path: source,
        destinationPath: destination,
        processId: null,
    });
    await writeFile(source, 'replacement must remain');
    await expect(fixture.host.publish(source, destination)).rejects.toMatchObject({
        code: ConnectorHostErrorCode.AlreadyExists,
        definitive: true,
    });
    expect(await readFile(source, 'utf8')).toBe('replacement must remain');
    expect(await readFile(destination, 'utf8')).toBe('complete publication');
    fixture.allowed = false;
    await expect(fixture.host.publish(source, 'refused.bin')).rejects.toThrow('revoked');
    await expect(stat(join(fixture.directory, 'refused.bin'))).rejects.toThrow();
});

it('a post-publication cleanup failure retains both real paths and reports uncertainty without retrying', async (): Promise<void> => {
    await using fixture: HostWorkspaceFixture = await HostWorkspaceFixture.create();
    const source: string = join(fixture.directory, 'stage.bin');
    const destination: string = join(fixture.directory, 'final.bin');
    await writeFile(source, 'installed bytes');
    faults.source = source;
    try {
        const publication: Promise<void> = fixture.host.publish(source, destination);
        await expect(publication).rejects.toThrow('original source cleanup is unconfirmed');
        await expect(publication).rejects.not.toBeInstanceOf(HostOperationError);
        expect(await readFile(source, 'utf8')).toBe('installed bytes');
        expect(await readFile(destination, 'utf8')).toBe('installed bytes');
        expect((await stat(source, { bigint: true })).ino).toBe(
            (await stat(destination, { bigint: true })).ino,
        );
    } finally {
        faults.source = null;
    }
});

it.skipIf(process.platform === 'win32')(
    'publication refuses nonregular and symlink sources while stat following remains explicit',
    async (): Promise<void> => {
        await using fixture: HostWorkspaceFixture = await HostWorkspaceFixture.create();
        const source: string = join(fixture.directory, 'source.bin');
        await writeFile(source, 'target bytes');
        await symlink(source, join(fixture.directory, 'symbolic.bin'));
        expect(await fixture.host.stat('symbolic.bin')).toMatchObject({
            kind: HostFileKind.Symlink,
        });
        expect(await fixture.host.stat('symbolic.bin', true)).toMatchObject({
            kind: HostFileKind.File,
            size: 12n,
        });
        await expect(fixture.host.publish('symbolic.bin', 'refused.bin')).rejects.toThrow(
            'non-symlink',
        );
        await expect(fixture.host.publish('.', 'refused-directory')).rejects.toThrow('non-symlink');
        await expect(stat(join(fixture.directory, 'refused.bin'))).rejects.toThrow();
        expect(await readFile(source, 'utf8')).toBe('target bytes');
    },
);
