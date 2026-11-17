// SPDX-FileCopyrightText: 2026 Nerva contributors
// SPDX-License-Identifier: LicenseRef-Proprietary

import { createHash } from 'node:crypto';
import { mkdir, writeFile, readFile, rename, symlink, link, readdir, stat } from 'node:fs/promises';
import { join } from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { expect, it } from 'vitest';
import { Boundary } from 'nerva-connector-protocol/protocol/Boundary.js';
import { ConnectorFilesystem } from '../src/runtime/ConnectorFilesystem.js';
import { FilesystemFixture } from './support/FilesystemFixture.js';
import {
    ConnectorFileFailure,
    ConnectorFileMode,
    ConnectorFilePermissionMode,
    type ConnectorFileEntry,
    type ConnectorFileResponse,
} from 'nerva-connector-protocol/protocol/ConnectorFiles.js';
import { ConnectorFileKind } from 'nerva-connector-protocol/protocol/ConnectorFileTypes.js';
import {
    ConnectorFileAction,
    ConnectorWriteMode,
} from 'nerva-connector-protocol/protocol/ConnectorFileTypes.js';

const helper: string | undefined = process.env['NERVA_CONNECTOR_FILES_HELPER'];

it.skipIf(helper === undefined)(
    'private chmod changes only regular files and rejects readonly grants, missing dispatch authority and link escapes',
    async (): Promise<void> => {
        await using fixture: FilesystemFixture = await FilesystemFixture.create(
            ConnectorFileMode.ReadWrite,
        );
        await using service: ConnectorFilesystem = await ConnectorFilesystem.load(
            fixture.policy,
            [],
        );
        const stagingId: string = 'a'.repeat(64);
        await writeFile(join(fixture.root, 'script'), 'preserved', { mode: 0o600 });
        expect(
            await fixture.call(service, ConnectorFileAction.Chmod, 'script', {
                mode: ConnectorFilePermissionMode.Executable,
            }),
        ).toEqual({ ok: false, error: ConnectorFileFailure.Denied });
        for (const mode of [
            ConnectorFilePermissionMode.Executable,
            ConnectorFilePermissionMode.Private,
        ]) {
            expect(
                await fixture.call(
                    service,
                    ConnectorFileAction.Chmod,
                    'script',
                    { mode },
                    stagingId,
                ),
            ).toMatchObject({
                ok: true,
                result: {
                    action: ConnectorFileAction.Chmod,
                    metadata: { kind: ConnectorFileKind.File, mode },
                },
            });
            expect((await stat(join(fixture.root, 'script'))).mode & 0o777).toBe(mode.valueOf());
            expect(await readFile(join(fixture.root, 'script'), 'utf8')).toBe('preserved');
        }
        expect(
            await fixture.call(
                service,
                ConnectorFileAction.Chmod,
                'script',
                { mode: 0o755 },
                stagingId,
            ),
        ).toEqual({ ok: false, error: ConnectorFileFailure.Invalid });
        const outside: string = join(fixture.directory, 'outside');
        await writeFile(outside, 'outside-content', { mode: 0o600 });
        await symlink(outside, join(fixture.root, 'symbolic'));
        await link(outside, join(fixture.root, 'hard'));
        await mkdir(join(fixture.root, 'directory'));
        await promisify(execFile)('/usr/bin/mkfifo', [join(fixture.root, 'pipe')]);
        for (const path of ['symbolic', 'hard', 'directory', 'pipe', '.', '../outside']) {
            expect(
                (
                    await fixture.call(
                        service,
                        ConnectorFileAction.Chmod,
                        path,
                        { mode: ConnectorFilePermissionMode.Executable },
                        stagingId,
                    )
                ).ok,
            ).toBe(false);
        }
        expect((await stat(outside)).mode & 0o777).toBe(0o600);
        expect(await readFile(outside, 'utf8')).toBe('outside-content');
        await using restricted: FilesystemFixture = await FilesystemFixture.create();
        await using reader: ConnectorFilesystem = await ConnectorFilesystem.load(
            restricted.policy,
            [],
        );
        await writeFile(join(restricted.root, 'script'), 'readonly', { mode: 0o600 });
        expect(
            await restricted.call(
                reader,
                ConnectorFileAction.Chmod,
                'script',
                { mode: ConnectorFilePermissionMode.Executable },
                stagingId,
            ),
        ).toEqual({ ok: false, error: ConnectorFileFailure.Denied });
        expect((await stat(join(restricted.root, 'script'))).mode & 0o777).toBe(0o600);
    },
);

it.skipIf(helper === undefined)(
    'rename moves one regular file within its captured root and requires exact create or existing-target replacement semantics',
    async (): Promise<void> => {
        await using fixture: FilesystemFixture = await FilesystemFixture.create(
            ConnectorFileMode.ReadWrite,
        );
        await using service: ConnectorFilesystem = await ConnectorFilesystem.load(
            fixture.policy,
            [],
        );
        const stagingId: string = 'b'.repeat(64);
        await mkdir(join(fixture.root, 'nested'));
        await writeFile(join(fixture.root, 'source'), 'original', { mode: 0o600 });
        expect(
            await fixture.call(service, ConnectorFileAction.Rename, 'source', {
                destination: 'nested/moved',
                mode: ConnectorWriteMode.Create,
            }),
        ).toEqual({ ok: false, error: ConnectorFileFailure.Denied });
        expect(
            await fixture.call(
                service,
                ConnectorFileAction.Rename,
                'source',
                { destination: 'nested/moved', mode: ConnectorWriteMode.Create },
                stagingId,
            ),
        ).toMatchObject({
            ok: true,
            result: {
                action: ConnectorFileAction.Rename,
                metadata: { kind: ConnectorFileKind.File, sizeBytes: 8n },
            },
        });
        await expect(readFile(join(fixture.root, 'source'))).rejects.toMatchObject({
            code: 'ENOENT',
        });
        expect(await readFile(join(fixture.root, 'nested/moved'), 'utf8')).toBe('original');
        await writeFile(join(fixture.root, 'source'), 'replacement', { mode: 0o600 });
        expect(
            await fixture.call(
                service,
                ConnectorFileAction.Rename,
                'source',
                { destination: 'nested/moved', mode: ConnectorWriteMode.Create },
                stagingId,
            ),
        ).toEqual({ ok: false, error: ConnectorFileFailure.Changed });
        expect(await readFile(join(fixture.root, 'nested/moved'), 'utf8')).toBe('original');
        expect(
            await fixture.call(
                service,
                ConnectorFileAction.Rename,
                'source',
                { destination: 'missing', mode: ConnectorWriteMode.Replace },
                stagingId,
            ),
        ).toEqual({ ok: false, error: ConnectorFileFailure.Denied });
        expect(await readFile(join(fixture.root, 'source'), 'utf8')).toBe('replacement');
        await expect(readFile(join(fixture.root, 'missing'))).rejects.toMatchObject({
            code: 'ENOENT',
        });
        expect(
            await fixture.call(
                service,
                ConnectorFileAction.Rename,
                'source',
                { destination: 'nested/moved', mode: ConnectorWriteMode.Replace },
                stagingId,
            ),
        ).toMatchObject({
            ok: true,
            result: {
                action: ConnectorFileAction.Rename,
                metadata: { kind: ConnectorFileKind.File, sizeBytes: 11n },
            },
        });
        expect(await readFile(join(fixture.root, 'nested/moved'), 'utf8')).toBe('replacement');
        const outside: string = join(fixture.directory, 'outside');
        await writeFile(outside, 'outside-content', { mode: 0o600 });
        await symlink(outside, join(fixture.root, 'symbolic'));
        await link(outside, join(fixture.root, 'hard'));
        await writeFile(join(fixture.root, 'safe'), 'must-stay', { mode: 0o600 });
        for (const path of ['symbolic', 'hard', 'nested', '.', '../outside']) {
            expect(
                (
                    await fixture.call(
                        service,
                        ConnectorFileAction.Rename,
                        path,
                        { destination: 'target', mode: ConnectorWriteMode.Create },
                        stagingId,
                    )
                ).ok,
            ).toBe(false);
        }
        for (const destination of ['symbolic', 'hard', 'nested', '.', '../outside', 'safe']) {
            expect(
                (
                    await fixture.call(
                        service,
                        ConnectorFileAction.Rename,
                        'safe',
                        { destination, mode: ConnectorWriteMode.Replace },
                        stagingId,
                    )
                ).ok,
            ).toBe(false);
        }
        expect(await readFile(outside, 'utf8')).toBe('outside-content');
        expect(await readFile(join(fixture.root, 'safe'), 'utf8')).toBe('must-stay');
        expect(await readdir(join(fixture.directory, 'staging'))).toEqual([]);
        await using restricted: FilesystemFixture = await FilesystemFixture.create();
        await using reader: ConnectorFilesystem = await ConnectorFilesystem.load(
            restricted.policy,
            [],
        );
        await writeFile(join(restricted.root, 'source'), 'readonly', { mode: 0o600 });
        expect(
            await restricted.call(
                reader,
                ConnectorFileAction.Rename,
                'source',
                { destination: 'target', mode: ConnectorWriteMode.Create },
                stagingId,
            ),
        ).toEqual({ ok: false, error: ConnectorFileFailure.Denied });
        expect(await readFile(join(restricted.root, 'source'), 'utf8')).toBe('readonly');
    },
);

it.skipIf(helper === undefined)(
    'explicit read-write policy atomically creates and replaces bounded private files without leaving staging data',
    async (): Promise<void> => {
        await using fixture: FilesystemFixture = await FilesystemFixture.create(
            ConnectorFileMode.ReadWrite,
        );
        await using service: ConnectorFilesystem = await ConnectorFilesystem.load(
            fixture.policy,
            [],
        );
        expect(
            await service.dispatch(
                JSON.stringify({
                    action: ConnectorFileAction.Remove,
                    requestId: 'no-dispatch',
                    policySha256: service.profile.policySha256,
                    rootId: 'project',
                    path: 'tree',
                    recursive: true,
                }),
            ),
        ).toEqual({ ok: false, error: ConnectorFileFailure.Denied });
        const bytes: Buffer = Buffer.alloc(16384, 0x41);
        expect(service.profile.maximumWriteBytes).toBe(16384);
        expect(
            (
                await fixture.call(
                    service,
                    ConnectorFileAction.Write,
                    'created',
                    { mode: ConnectorWriteMode.Create, dataBase64: bytes.toString('base64') },
                    'a'.repeat(64),
                )
            ).ok,
        ).toBe(true);
        expect(await readFile(join(fixture.root, 'created'))).toEqual(bytes);
        expect((await stat(join(fixture.root, 'created'))).mode & 0o777).toBe(0o600);
        const repeated: ConnectorFileResponse = await fixture.call(
            service,
            ConnectorFileAction.Write,
            'created',
            {
                mode: ConnectorWriteMode.Create,
                dataBase64: Buffer.from('different').toString('base64'),
            },
            'b'.repeat(64),
        );
        expect(repeated).toEqual({ ok: false, error: ConnectorFileFailure.Changed });
        expect(await readFile(join(fixture.root, 'created'))).toEqual(bytes);
        expect(
            (
                await fixture.call(
                    service,
                    ConnectorFileAction.Write,
                    'created',
                    {
                        mode: ConnectorWriteMode.Replace,
                        dataBase64: Buffer.from('short').toString('base64'),
                    },
                    'c'.repeat(64),
                )
            ).ok,
        ).toBe(true);
        expect(await readFile(join(fixture.root, 'created'), 'utf8')).toBe('short');
        expect(await readdir(join(fixture.directory, 'staging'))).toEqual([]);
    },
);

it.skipIf(helper === undefined)(
    'read-only roots, missing original staging identity and symlink/hardlink/traversal destinations cannot write',
    async (): Promise<void> => {
        await using fixture: FilesystemFixture = await FilesystemFixture.create(
            ConnectorFileMode.ReadWrite,
        );
        await using service: ConnectorFilesystem = await ConnectorFilesystem.load(
            fixture.policy,
            [],
        );
        const outside: string = join(fixture.directory, 'private');
        await writeFile(outside, 'unchanged');
        await symlink(outside, join(fixture.root, 'symbolic'));
        await link(outside, join(fixture.root, 'hard'));
        for (const path of ['symbolic', 'hard', '../private']) {
            expect(
                (
                    await fixture.call(
                        service,
                        ConnectorFileAction.Write,
                        path,
                        { mode: ConnectorWriteMode.Replace, dataBase64: 'Y2hhbmdlZA==' },
                        'd'.repeat(64),
                    )
                ).ok,
            ).toBe(false);
        }
        expect(
            (
                await fixture.call(service, ConnectorFileAction.Write, 'new', {
                    mode: ConnectorWriteMode.Create,
                    dataBase64: 'eA==',
                })
            ).ok,
        ).toBe(false);
        expect(await readFile(outside, 'utf8')).toBe('unchanged');
        await using readOnly: FilesystemFixture = await FilesystemFixture.create();
        await using reader: ConnectorFilesystem = await ConnectorFilesystem.load(
            readOnly.policy,
            [],
        );
        expect(reader.profile.maximumWriteBytes).toBe(0);
        expect(
            (
                await readOnly.call(
                    reader,
                    ConnectorFileAction.Write,
                    'new',
                    { mode: ConnectorWriteMode.Create, dataBase64: 'eA==' },
                    'e'.repeat(64),
                )
            ).ok,
        ).toBe(false);
    },
);

/** Owned project data and private operator policy never use application or customer directories. */
it.skipIf(helper === undefined)(
    'qualified native reads, exact offsets and bounded directory pages obey local policy',
    async (): Promise<void> => {
        await using fixture: FilesystemFixture = await FilesystemFixture.create();
        await writeFile(join(fixture.root, 'hello'), Buffer.from([0, 1, 2, 255]));
        const expected: string[] = [];
        for (let index: number = 0; index < 170; index++) {
            const name: string = index.toString().padStart(3, '0') + '"'.repeat(200);
            expected.push(name);
            await writeFile(join(fixture.root, name), '');
        }
        await using service: ConnectorFilesystem = await ConnectorFilesystem.load(
            fixture.policy,
            [],
        );
        const read: ConnectorFileResponse = await fixture.call(
            service,
            ConnectorFileAction.Read,
            'hello',
            { offset: '0', limit: 32768 },
        );
        expect(
            read.ok &&
                read.result.action === ConnectorFileAction.Read &&
                Buffer.from(read.result.dataBase64, 'base64'),
        ).toEqual(Buffer.from([0, 1, 2, 255]));
        const exact: ConnectorFileResponse = await fixture.call(
            service,
            ConnectorFileAction.Read,
            'hello',
            { offset: '9007199254740993', limit: 1 },
        );
        expect(
            exact.ok && exact.result.action === ConnectorFileAction.Read && exact.result.offset,
        ).toBe(9007199254740993n);
        const names: string[] = [];
        let cursor: string = '0';
        for (let page: number = 0; page < 10; page++) {
            const response: ConnectorFileResponse = await fixture.call(
                service,
                ConnectorFileAction.List,
                '.',
                { cursor },
            );
            if (!response.ok || response.result.action !== ConnectorFileAction.List) {
                throw new Error('Native directory listing failed');
            }
            expect(response.result.entries.length).toBeLessThanOrEqual(128);
            expect(response.result.metadata.kind).toBe(ConnectorFileKind.Directory);
            names.push(
                ...response.result.entries.map((entry: ConnectorFileEntry): string => entry.name),
            );
            if (response.result.nextCursor === null) {
                break;
            }
            cursor = response.result.nextCursor.toString();
        }
        expect(names.sort()).toEqual([...expected, 'hello'].sort());
        expect(await fixture.call(service, ConnectorFileAction.Stat, 'hello')).toMatchObject({
            ok: true,
            result: { metadata: { sizeBytes: 4n } },
        });
    },
);

it.skipIf(helper === undefined)(
    'traversal, links, special files, extra authority and stale policy cannot expose outside content',
    async (): Promise<void> => {
        await using fixture: FilesystemFixture = await FilesystemFixture.create();
        const outside: string = join(fixture.directory, 'private');
        await writeFile(outside, 'private fixture data', { mode: 0o600 });
        await symlink(outside, join(fixture.root, 'symlink'));
        await link(outside, join(fixture.root, 'hardlink'));
        await promisify(execFile)('/usr/bin/mkfifo', [join(fixture.root, 'pipe')]);
        await using service: ConnectorFilesystem = await ConnectorFilesystem.load(
            fixture.policy,
            [],
        );
        for (const path of ['symlink', 'hardlink', 'pipe']) {
            expect(
                await fixture.call(service, ConnectorFileAction.Read, path, {
                    offset: '0',
                    limit: 100,
                }),
            ).toEqual({ ok: false, error: ConnectorFileFailure.Denied });
        }
        for (const path of ['../private', '/etc/passwd', 'a/../private', './hello']) {
            expect(
                await fixture.call(service, ConnectorFileAction.Read, path, {
                    offset: '0',
                    limit: 100,
                }),
            ).toEqual({ ok: false, error: ConnectorFileFailure.Invalid });
        }
        expect(
            await fixture.call(service, ConnectorFileAction.Stat, '.', { rootId: 'other' }),
        ).toEqual({ ok: false, error: ConnectorFileFailure.Denied });
        expect(
            await fixture.call(service, ConnectorFileAction.Stat, '.', {
                policySha256: '0'.repeat(64),
            }),
        ).toEqual({ ok: false, error: ConnectorFileFailure.Changed });
        expect(
            await fixture.call(service, ConnectorFileAction.Stat, '.', { command: 'sh' }),
        ).toEqual({ ok: false, error: ConnectorFileFailure.Invalid });
        expect(
            await service.dispatch(JSON.stringify({ action: 'write', requestId: 'denied' })),
        ).toEqual({ ok: false, error: ConnectorFileFailure.Invalid });
        expect(await readFile(outside, 'utf8')).toBe('private fixture data');
    },
);

it.skipIf(helper === undefined)(
    'pinned roots survive a pathname replacement and child admission recovers only after actual exit',
    async (): Promise<void> => {
        await using fixture: FilesystemFixture = await FilesystemFixture.create();
        await writeFile(join(fixture.root, 'value'), 'original');
        await using service: ConnectorFilesystem = await ConnectorFilesystem.load(
            fixture.policy,
            [],
        );
        await rename(fixture.root, join(fixture.directory, 'original-root'));
        await mkdir(fixture.root);
        await writeFile(join(fixture.root, 'value'), 'replacement');
        const response: ConnectorFileResponse = await fixture.call(
            service,
            ConnectorFileAction.Read,
            'value',
            { offset: '0', limit: 100 },
        );
        expect(
            response.ok &&
                response.result.action === ConnectorFileAction.Read &&
                Buffer.from(response.result.dataBase64, 'base64').toString(),
        ).toBe('original');
        const results: readonly ConnectorFileResponse[] = await Promise.all(
            Array.from({ length: 8 }, (): Promise<ConnectorFileResponse> =>
                fixture.call(service, ConnectorFileAction.Stat, '.'),
            ),
        );
        expect(results.filter((entry: ConnectorFileResponse): boolean => entry.ok)).toHaveLength(4);
        expect(
            results.filter(
                (entry: ConnectorFileResponse): boolean =>
                    !entry.ok && entry.error === ConnectorFileFailure.Unavailable,
            ),
        ).toHaveLength(4);
        expect((await fixture.call(service, ConnectorFileAction.Stat, '.')).ok).toBe(true);
        await service[Symbol.asyncDispose]();
        expect(await fixture.call(service, ConnectorFileAction.Stat, '.')).toEqual({
            ok: false,
            error: ConnectorFileFailure.Unavailable,
        });
    },
);

it.skipIf(helper === undefined)(
    'unreviewed helper bytes, broad secret roots and unsupported profiles fail before access',
    async (): Promise<void> => {
        await using fixture: FilesystemFixture = await FilesystemFixture.create();
        const original: string = await readFile(fixture.policy, 'utf8');
        const rawPolicy: unknown = JSON.parse(original);
        const policy: Readonly<Record<string, unknown>> = Boundary.record(rawPolicy, [
            'mode',
            'revision',
            'helperFile',
            'helperSha256',
            'roots',
        ]);
        for (const replacement of [
            { helperSha256: '0'.repeat(64) },
            { mode: 'read-write' },
            { roots: [] },
            { roots: [{ id: 'broad', path: fixture.directory }] },
        ]) {
            await writeFile(fixture.policy, JSON.stringify({ ...policy, ...replacement }));
            await expect(ConnectorFilesystem.load(fixture.policy, [])).rejects.toThrow();
        }
        await writeFile(fixture.policy, original);
        const script: string = join(fixture.directory, 'not-native');
        const marker: string = join(fixture.directory, 'script-executed');
        const quoted: string = "'" + marker.replaceAll("'", "'\\''") + "'";
        await writeFile(script, '#!/bin/sh\n: > ' + quoted + '\n#' + 'x'.repeat(128) + '\n', {
            mode: 0o700,
        });
        await writeFile(
            fixture.policy,
            JSON.stringify({
                ...policy,
                helperFile: script,
                helperSha256: createHash('sha256')
                    .update(await readFile(script))
                    .digest('hex'),
            }),
        );
        await expect(ConnectorFilesystem.load(fixture.policy, [])).rejects.toThrow();
        await expect(readFile(marker)).rejects.toMatchObject({ code: 'ENOENT' });
        await writeFile(fixture.policy, original);
        await expect(
            ConnectorFilesystem.load(fixture.policy, [join(fixture.root, 'device-private-key')]),
        ).rejects.toThrow();
    },
);

it.skipIf(helper === undefined)(
    'removal stays within granted roots and unlinks links without touching their targets',
    async (): Promise<void> => {
        await using fixture: FilesystemFixture = await FilesystemFixture.create(
            ConnectorFileMode.ReadWrite,
        );
        const outside: string = join(fixture.directory, 'outside');
        await mkdir(outside);
        await writeFile(join(outside, 'secret'), 'must-survive');
        await mkdir(join(fixture.root, 'tree', 'nested'), { recursive: true });
        await writeFile(join(fixture.root, 'tree', 'nested', 'data'), 'data');
        await symlink(outside, join(fixture.root, 'tree', 'link'));
        await link(join(outside, 'secret'), join(fixture.root, 'tree', 'hardlink'));
        await promisify(execFile)('/usr/bin/mkfifo', [join(fixture.root, 'tree', 'pipe')]);
        await using service: ConnectorFilesystem = await ConnectorFilesystem.load(
            fixture.policy,
            [],
        );
        expect(
            await fixture.call(service, ConnectorFileAction.Remove, 'tree', { recursive: false }),
        ).toEqual({ ok: false, error: ConnectorFileFailure.Changed });
        expect(await readFile(join(fixture.root, 'tree', 'nested', 'data'), 'utf8')).toBe('data');
        expect(
            await fixture.call(service, ConnectorFileAction.Remove, 'tree/link/secret', {
                recursive: false,
            }),
        ).toEqual({ ok: false, error: ConnectorFileFailure.Denied });
        const result: ConnectorFileResponse = await fixture.call(
            service,
            ConnectorFileAction.Remove,
            'tree',
            { recursive: true },
        );
        expect(result).toMatchObject({
            ok: true,
            result: { action: ConnectorFileAction.Remove, entriesRemoved: 6n },
        });
        await expect(readFile(join(fixture.root, 'tree', 'nested', 'data'))).rejects.toMatchObject({
            code: 'ENOENT',
        });
        expect(await readFile(join(outside, 'secret'), 'utf8')).toBe('must-survive');
        for (const path of ['.', '..', '/etc', '../outside', 'tree/../outside']) {
            expect(
                await fixture.call(service, ConnectorFileAction.Remove, path, { recursive: true }),
            ).toEqual({ ok: false, error: ConnectorFileFailure.Invalid });
        }
        await using readerFixture: FilesystemFixture = await FilesystemFixture.create();
        await writeFile(join(readerFixture.root, 'keep'), 'keep');
        await using reader: ConnectorFilesystem = await ConnectorFilesystem.load(
            readerFixture.policy,
            [],
        );
        expect(
            await readerFixture.call(reader, ConnectorFileAction.Remove, 'keep', {
                recursive: false,
            }),
        ).toEqual({ ok: false, error: ConnectorFileFailure.Denied });
        expect(await readFile(join(readerFixture.root, 'keep'), 'utf8')).toBe('keep');
    },
);

it.skipIf(helper === undefined)(
    'recursive removal has exact entry and depth ceilings and reports partial effects honestly',
    async (): Promise<void> => {
        await using fixture: FilesystemFixture = await FilesystemFixture.create(
            ConnectorFileMode.ReadWrite,
        );
        const tree: string = join(fixture.root, 'many');
        await mkdir(tree);
        for (let start: number = 0; start < 4100; start += 100) {
            await Promise.all(
                Array.from({ length: 100 }, (_value: unknown, index: number): Promise<void> =>
                    writeFile(join(tree, String(start + index)), ''),
                ),
            );
        }
        const deep: string = join(
            fixture.root,
            'deep',
            ...Array.from({ length: 33 }, (): string => 'd'),
        );
        await mkdir(deep, { recursive: true });
        await writeFile(join(deep, 'keep'), 'keep');
        await using service: ConnectorFilesystem = await ConnectorFilesystem.load(
            fixture.policy,
            [],
        );
        expect(
            await fixture.call(service, ConnectorFileAction.Remove, 'deep', { recursive: true }),
        ).toEqual({ ok: false, error: ConnectorFileFailure.Denied });
        expect(await readFile(join(deep, 'keep'), 'utf8')).toBe('keep');
        expect(
            await fixture.call(service, ConnectorFileAction.Remove, 'many', { recursive: true }),
        ).toEqual({ ok: false, error: ConnectorFileFailure.Indeterminate });
        const remaining: readonly string[] = await readdir(tree);
        expect(remaining).toHaveLength(4);
    },
);

it.skipIf(helper === undefined)(
    'directory creation needs an explicit write grant, creates private single entries and refuses existing entries, links and traversal',
    async (): Promise<void> => {
        await using fixture: FilesystemFixture = await FilesystemFixture.create(
            ConnectorFileMode.ReadWrite,
        );
        await using service: ConnectorFilesystem = await ConnectorFilesystem.load(
            fixture.policy,
            [],
        );
        const stagingId: string = 'a'.repeat(64);
        expect(await fixture.call(service, ConnectorFileAction.Mkdir, 'missing-authority')).toEqual(
            {
                ok: false,
                error: ConnectorFileFailure.Denied,
            },
        );
        const inheritedMask: number = process.umask(0o777);
        let creation: ConnectorFileResponse;
        try {
            creation = await fixture.call(
                service,
                ConnectorFileAction.Mkdir,
                'created',
                {},
                stagingId,
            );
        } finally {
            process.umask(inheritedMask);
        }
        expect(creation).toMatchObject({
            ok: true,
            result: { action: ConnectorFileAction.Mkdir },
        });
        expect((await stat(join(fixture.root, 'created'))).mode & 0o777).toBe(0o700);
        expect(
            await fixture.call(service, ConnectorFileAction.Mkdir, 'created/nested', {}, stagingId),
        ).toMatchObject({ ok: true });
        expect(
            await fixture.call(service, ConnectorFileAction.Mkdir, 'created', {}, stagingId),
        ).toEqual({
            ok: false,
            error: ConnectorFileFailure.Changed,
        });
        const outside: string = join(fixture.directory, 'outside-directory');
        await mkdir(outside);
        await symlink(outside, join(fixture.root, 'link'));
        await writeFile(join(fixture.root, 'file'), 'preserved');
        for (const path of [
            'missing/child',
            'link/child',
            'link',
            'file',
            '.',
            '..',
            '../outside-directory/child',
            '/tmp/child',
        ]) {
            expect(
                (await fixture.call(service, ConnectorFileAction.Mkdir, path, {}, stagingId)).ok,
            ).toBe(false);
        }
        expect(await readdir(outside)).toEqual([]);
        expect(await readFile(join(fixture.root, 'file'), 'utf8')).toBe('preserved');
        expect(await readdir(join(fixture.directory, 'staging'))).toEqual([]);
        await using readerFixture: FilesystemFixture = await FilesystemFixture.create();
        await using reader: ConnectorFilesystem = await ConnectorFilesystem.load(
            readerFixture.policy,
            [],
        );
        expect(
            await readerFixture.call(reader, ConnectorFileAction.Mkdir, 'denied', {}, stagingId),
        ).toEqual({
            ok: false,
            error: ConnectorFileFailure.Denied,
        });
        expect(await readdir(readerFixture.root)).toEqual([]);
    },
);
