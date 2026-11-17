// SPDX-FileCopyrightText: 2026 Nerva contributors
// SPDX-License-Identifier: LicenseRef-Proprietary

import { expect, it } from 'vitest';
import { mkdtemp, mkdir, writeFile, readFile, rm, chmod, link, lstat } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import { ConnectorNativePlans } from '../src/native/ConnectorNativePlan.js';
import { ConnectorNativeRuntime } from '../src/native/ConnectorNativeRuntime.js';
import {
    ConnectorRuntimeFileMode,
    type ConnectorNativeLayout,
    type ConnectorRuntimeFile,
} from '../src/native/ConnectorNativeTypes.js';

/** One small public-byte tree exercises bounded copy/recovery without a service, package manager or kernel policy mutation. */
class NativeRuntimeFixture implements AsyncDisposable {
    private constructor(
        public readonly directory: string,
        public readonly layout: ConnectorNativeLayout,
        public readonly files: readonly ConnectorRuntimeFile[],
    ) {}
    /** No installed dependency/cache tree is copied; the deliberately tiny executable/data bytes are independent source assets. */
    public static async create(): Promise<NativeRuntimeFixture> {
        const directory: string = await mkdtemp(join(homedir(), 'nerva-native-runtime-test-'));
        const layout: ConnectorNativeLayout = ConnectorNativePlans.layout(
            join(directory, 'installed'),
        );
        const files: ConnectorRuntimeFile[] = [];
        try {
            for (const path of ['usr/bin/probe', 'etc/tool.conf']) {
                await mkdir(join(directory, 'source', path, '..'), {
                    recursive: true,
                    mode: 0o700,
                });
                const mode: ConnectorRuntimeFileMode = path.endsWith('probe')
                    ? ConnectorRuntimeFileMode.Executable
                    : ConnectorRuntimeFileMode.Data;
                const bytes: Buffer = Buffer.from(path + '\n');
                await writeFile(join(directory, 'source', path), bytes, {
                    mode: mode === ConnectorRuntimeFileMode.Executable ? 0o700 : 0o600,
                });
                files.push({
                    path: '/' + path,
                    mode,
                    sizeBytes: BigInt(bytes.byteLength),
                    sha256: createHash('sha256').update(bytes).digest('hex'),
                });
            }
            return new NativeRuntimeFixture(directory, layout, files);
        } catch (caught: unknown) {
            await rm(directory, { recursive: true, force: true });
            throw caught;
        }
    }
    /** Only this private source/output fixture is removed after its owned readers close. */
    public async [Symbol.asyncDispose](): Promise<void> {
        await rm(this.directory, { recursive: true, force: true });
    }
}

it('native runtime copies only approved bytes, freezes all paths, and repeats without source access at boot', async (): Promise<void> => {
    await using fixture: NativeRuntimeFixture = await NativeRuntimeFixture.create();
    await ConnectorNativeRuntime.prepare(
        fixture.layout,
        join(fixture.directory, 'source'),
        fixture.files,
        new AbortController().signal,
    );
    const path: string = join(fixture.layout.runtimeDirectory, 'usr/bin/probe');
    const inode: bigint = (await lstat(path, { bigint: true })).ino;
    expect((await lstat(path)).mode & 0o222).toBe(0);
    await ConnectorNativeRuntime.prepare(
        fixture.layout,
        join(fixture.directory, 'source'),
        fixture.files,
        new AbortController().signal,
    );
    expect((await lstat(path, { bigint: true })).ino).toBe(inode);
    await rm(join(fixture.directory, 'source'), { recursive: true });
    await ConnectorNativeRuntime.verify(
        fixture.layout,
        fixture.files,
        new AbortController().signal,
    );
    expect(await readFile(path, 'utf8')).toBe('usr/bin/probe\n');
});

it('interrupted publication joins an original hardlinked readonly partial without creating another runtime version', async (): Promise<void> => {
    await using fixture: NativeRuntimeFixture = await NativeRuntimeFixture.create();
    const path: string = join(fixture.layout.runtimeDirectory, 'usr/bin/probe');
    await mkdir(join(fixture.layout.runtimeDirectory, 'usr/bin'), { recursive: true, mode: 0o700 });
    await writeFile(path, 'usr/bin/probe\n', { mode: 0o555 });
    await link(path, path + '.partial');
    await ConnectorNativeRuntime.prepare(
        fixture.layout,
        join(fixture.directory, 'source'),
        fixture.files,
        new AbortController().signal,
    );
    expect((await lstat(path)).nlink).toBe(1);
    await expect(lstat(path + '.partial')).rejects.toThrow();
    await ConnectorNativeRuntime.verify(
        fixture.layout,
        fixture.files,
        new AbortController().signal,
    );
});

it('changed content, inserted files and missing namespace mount targets prevent native boot rather than being repaired', async (): Promise<void> => {
    await using fixture: NativeRuntimeFixture = await NativeRuntimeFixture.create();
    await ConnectorNativeRuntime.prepare(
        fixture.layout,
        join(fixture.directory, 'source'),
        fixture.files,
        new AbortController().signal,
    );
    await chmod(join(fixture.layout.runtimeDirectory, 'etc/tool.conf'), 0o600);
    await writeFile(join(fixture.layout.runtimeDirectory, 'etc/tool.conf'), 'substituted');
    await chmod(join(fixture.layout.runtimeDirectory, 'etc/tool.conf'), 0o444);
    await expect(
        ConnectorNativeRuntime.verify(fixture.layout, fixture.files, new AbortController().signal),
    ).rejects.toThrow();
    await writeFile(join(fixture.layout.runtimeDirectory, 'unexpected'), 'foreign', {
        mode: 0o444,
    });
    await expect(
        ConnectorNativeRuntime.verify(fixture.layout, fixture.files, new AbortController().signal),
    ).rejects.toThrow();
    await rm(join(fixture.layout.runtimeDirectory, 'unexpected'));
    await rm(join(fixture.layout.runtimeDirectory, 'workspace'), { recursive: true });
    await expect(
        ConnectorNativeRuntime.verify(fixture.layout, fixture.files, new AbortController().signal),
    ).rejects.toThrow();
    await expect(lstat(join(fixture.layout.runtimeDirectory, 'workspace'))).rejects.toThrow();
});
