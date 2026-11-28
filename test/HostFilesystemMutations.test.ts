// SPDX-FileCopyrightText: 2026 Dacely <business@dacely.com>
// SPDX-License-Identifier: LicenseRef-Proprietary

import type { BigIntStats } from 'node:fs';
import { mkdir, mkdtemp, rm, writeFile, readFile, stat } from 'node:fs/promises';
import { join } from 'node:path';
import { expect, it } from 'vitest';
import { ConnectorHostTool } from 'nerva-connector-protocol/protocol/ConnectorHost.js';
import { HostFilesystem } from '../src/host/HostFilesystem.js';
import { HostOperation } from '../src/host/HostWorkspaceTypes.js';
import { ConnectorHostFailure } from '../src/runtime/ConnectorHostFailure.js';
import { HostWorkspaceFixture } from './support/HostWorkspaceFixture.js';

it('rename preserves the source file identity while replacing the destination and authorizes both endpoints', async (): Promise<void> => {
    await using fixture: HostWorkspaceFixture = await HostWorkspaceFixture.create();
    const source: string = join(fixture.directory, 'source.txt');
    const destination: string = join(fixture.directory, 'destination.txt');
    await writeFile(source, 'new complete contents');
    await writeFile(destination, 'old contents');
    const original: BigIntStats = await stat(source, { bigint: true });
    await fixture.host.rename('source.txt', 'destination.txt');
    const moved: BigIntStats = await stat(destination, { bigint: true });
    expect(moved.ino).toBe(original.ino);
    expect(moved.dev).toBe(original.dev);
    expect(await readFile(destination, 'utf8')).toBe('new complete contents');
    await expect(stat(source)).rejects.toThrow();
    expect(fixture.checks).toContainEqual({
        operation: HostOperation.Rename,
        path: source,
        destinationPath: destination,
        processId: null,
    });
    await writeFile(source, 'retained source');
    fixture.allowed = false;
    await expect(fixture.host.rename(source, destination)).rejects.toThrow('revoked');
    expect(await readFile(source, 'utf8')).toBe('retained source');
    expect(await readFile(destination, 'utf8')).toBe('new complete contents');
});

it.skipIf(process.platform === 'win32')(
    'chmod preserves exact POSIX mode intent and content, with no write after revocation',
    async (): Promise<void> => {
        await using fixture: HostWorkspaceFixture = await HostWorkspaceFixture.create();
        const path: string = join(fixture.directory, 'mode.txt');
        await writeFile(path, 'preserved contents', { mode: 0o600 });
        await fixture.host.chmod('mode.txt', 0o640);
        expect((await stat(path)).mode & 0o7777).toBe(0o640);
        expect(await readFile(path, 'utf8')).toBe('preserved contents');
        for (const mode of [-1, 0.5, 0o10000, Number.NaN]) {
            await expect(fixture.host.chmod(path, mode)).rejects.toThrow('resource limit');
        }
        fixture.allowed = false;
        await expect(fixture.host.chmod(path, 0o777)).rejects.toThrow('revoked');
        expect((await stat(path)).mode & 0o7777).toBe(0o640);
    },
);

it.skipIf(process.platform !== 'win32')(
    'Windows chmod explicitly rejects an incomplete POSIX-to-DACL permission mapping',
    async (): Promise<void> => {
        await expect(HostFilesystem.chmod('C:\\missing-file', 0o600)).rejects.toThrow('DACL');
    },
);

it.skipIf(process.platform !== 'linux')(
    'cross-filesystem rename fails without copying or removing the original file',
    async (): Promise<void> => {
        await using fixture: HostWorkspaceFixture = await HostWorkspaceFixture.create();
        const targetDirectory: string = await mkdtemp('/dev/shm/nerva-host-rename-');
        try {
            const source: string = join(fixture.directory, 'source.txt');
            const target: string = join(targetDirectory, 'destination.txt');
            await writeFile(source, 'original source');
            await writeFile(target, 'original destination');
            expect((await stat(source, { bigint: true })).dev).not.toBe(
                (await stat(target, { bigint: true })).dev,
            );
            await expect(fixture.host.rename(source, target)).rejects.toMatchObject({
                code: 'EXDEV',
            });
            expect(await readFile(source, 'utf8')).toBe('original source');
            expect(await readFile(target, 'utf8')).toBe('original destination');
        } finally {
            await rm(targetDirectory, { recursive: true, force: true });
        }
    },
);

it('removing a path that does not exist, or a directory without recursive intent, definitively removes nothing', async (): Promise<void> => {
    await using fixture: HostWorkspaceFixture = await HostWorkspaceFixture.create();
    let missing: unknown = null;
    try {
        await fixture.host.remove('missing-private-name', false);
    } catch (caught: unknown) {
        missing = caught;
    }
    expect(missing).toMatchObject({ code: 'not-found', definitive: true });
    expect(missing).toMatchObject({ cause: { code: 'ENOENT' } });
    expect(ConnectorHostFailure.response(ConnectorHostTool.FileRemove, missing)).toEqual({
        outcome: 'failed',
        resultJson: null,
        errorCode: 'not-found',
    });
    await expect(fixture.host.remove('missing/child', true)).rejects.toMatchObject({
        code: 'not-found',
        definitive: true,
    });
    await mkdir(join(fixture.directory, 'kept', 'inner'), { recursive: true });
    await writeFile(join(fixture.directory, 'kept', 'inner', 'file.txt'), 'kept');
    await expect(fixture.host.remove('kept', false)).rejects.toMatchObject({
        code: 'is-directory',
        definitive: true,
    });
    expect(await readFile(join(fixture.directory, 'kept', 'inner', 'file.txt'), 'utf8')).toBe(
        'kept',
    );
    await fixture.host.remove('kept', true);
    await expect(stat(join(fixture.directory, 'kept'))).rejects.toMatchObject({ code: 'ENOENT' });
});
