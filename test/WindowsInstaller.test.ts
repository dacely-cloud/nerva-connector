// SPDX-FileCopyrightText: 2026 Nerva contributors
// SPDX-License-Identifier: LicenseRef-Proprietary

import { execFile } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { promisify } from 'node:util';
import { afterEach, beforeEach, expect, it } from 'vitest';
import { ConnectorWindowsInstaller } from '../script/ConnectorWindowsInstaller.ts';
import { ConnectorWindowsResource } from '../script/ConnectorWindowsResource.ts';
import { ConnectorWindowsCompiler } from '../script/ConnectorWindowsCompiler.ts';

/** Mono runs the installer's own C# payload reader against a really built setup program. */
const mono: boolean =
    process.platform === 'linux' && existsSync('/usr/bin/mcs') && existsSync('/usr/bin/mono');

let directory: string = '';

beforeEach(async (): Promise<void> => {
    directory = await mkdtemp(join(tmpdir(), 'nerva-connector-installer-'));
});

afterEach(async (): Promise<void> => {
    await rm(directory, { recursive: true, force: true });
});

/** Builds a setup program from stand-in connector files, without the network or the real Node runtime. */
async function setup(): Promise<{ readonly path: string; readonly files: Map<string, Buffer> }> {
    const files: Map<string, Buffer> = new Map([
        ['node.exe', Buffer.from('MZ stand-in runtime '.repeat(4096))],
        ['nerva-connector.mjs', Buffer.from('#!/usr/bin/env node\nconsole.log("connector");\n')],
        ['nerva-connector-state.json', Buffer.from('{"bytes":1}\n')],
    ]);
    const sources: string = join(directory, 'sources');
    await mkdir(sources);
    for (const [name, bytes] of files) {
        await writeFile(join(sources, name), bytes);
    }
    const path: string = join(directory, 'Nerva-Connector-Setup-1.2.3-x64.exe');
    await ConnectorWindowsInstaller.build({
        work: join(directory, 'work'),
        destination: path,
        version: '1.2.3',
        architecture: 'x64',
        updates: null,
        files: [...files.keys()].map((name: string): { name: string; source: string } => ({
            name,
            source: join(sources, name),
        })),
    });
    return { path, files };
}

/** Compiles the test reader that loads a setup program and extracts its payload with InstallerPayload.cs. */
async function reader(): Promise<string> {
    const path: string = join(directory, 'reader.exe');
    await ConnectorWindowsCompiler.compile({
        sources: [
            resolve('test/support/WindowsInstallerPayloadFixture.cs'),
            resolve('native/windows/installer/InstallerPayload.cs'),
        ],
        entrypoint: 'NexaConnectorInstallerPayloadFixture',
        destination: path,
    });
    return path;
}

it('writes an icon group, an as-invoker manifest and version information into every Windows program', (): void => {
    const resource: Buffer = ConnectorWindowsResource.build(readFileSyncIcon(), {
        description: 'Nerva Connector Setup',
        fileName: 'Setup.exe',
        version: '1.2.3',
    });
    const types: number[] = [];
    for (let offset: number = 0; offset < resource.byteLength;) {
        const size: number = resource.readUInt32LE(offset);
        const header: number = resource.readUInt32LE(offset + 4);
        types.push(resource.readUInt16LE(offset + 10));
        offset += header + size + ((4 - (size % 4)) % 4);
    }
    expect(types[0]).toBe(0);
    expect(types.filter((type: number): boolean => type === 3).length).toBe(9);
    expect(types).toContain(14);
    expect(types).toContain(16);
    expect(types).toContain(24);
    const text: string = resource.toString('latin1');
    expect(text).toContain('requestedExecutionLevel level="asInvoker"');
    expect(resource.includes(Buffer.from('Nerva Connector Setup', 'utf16le'))).toBe(true);
    expect(resource.includes(Buffer.from('1.2.3.0', 'utf16le'))).toBe(true);
    expect((): Buffer =>
        ConnectorWindowsResource.build(readFileSyncIcon(), {
            description: 'x',
            fileName: 'x.exe',
            version: '1.70000',
        }),
    ).toThrow('versions');
});

it.skipIf(!mono)(
    'a built setup program carries the launcher, the uninstaller and every file, and installs them byte for byte',
    async (): Promise<void> => {
        const built: { readonly path: string; readonly files: Map<string, Buffer> } = await setup();
        expect(await readdir(directory)).not.toContain('work');
        const setupBytes: Buffer = await readFile(built.path);
        expect(setupBytes.subarray(0, 2).toString('latin1')).toBe('MZ');
        expect(setupBytes.includes(Buffer.from('asInvoker'))).toBe(true);
        const output: string = join(directory, 'installed');
        await mkdir(output);
        const result: { readonly stdout: string } = await promisify(execFile)(
            '/usr/bin/mono',
            [await reader(), built.path, output],
            { timeout: 60000 },
        );
        expect(result.stdout.trim()).toBe('1.2.3');
        expect((await readdir(output)).toSorted()).toEqual(
            [
                ConnectorWindowsInstaller.launcher,
                ConnectorWindowsInstaller.uninstaller,
                ...built.files.keys(),
            ].toSorted(),
        );
        for (const [name, bytes] of built.files) {
            expect((await readFile(join(output, name))).equals(bytes)).toBe(true);
        }
        const launcher: Buffer = await readFile(join(output, ConnectorWindowsInstaller.launcher));
        expect(launcher.subarray(0, 2).toString('latin1')).toBe('MZ');
        expect(launcher.includes(Buffer.from('Nerva Connector', 'utf16le'))).toBe(true);
    },
    120000,
);

it.skipIf(!mono)(
    'a setup program whose payload was altered is refused as damaged and leaves no file behind',
    async (): Promise<void> => {
        const built: { readonly path: string; readonly files: Map<string, Buffer> } = await setup();
        const bytes: Buffer = await readFile(built.path);
        const marker: number = bytes.indexOf(Buffer.from('NERVACP1', 'ascii'));
        expect(marker).toBeGreaterThan(0);
        const name: number = bytes.indexOf(Buffer.from('nerva-connector.mjs', 'ascii'), marker);
        expect(name).toBeGreaterThan(marker);
        const digest: number = name + 'nerva-connector.mjs'.length + 8;
        bytes.writeUInt8(bytes.readUInt8(digest) ^ 0xff, digest);
        const tampered: string = join(directory, 'tampered.exe');
        await writeFile(tampered, bytes);
        const output: string = join(directory, 'installed');
        await mkdir(output);
        const failure: unknown = await promisify(execFile)(
            '/usr/bin/mono',
            [await reader(), tampered, output],
            { timeout: 60000 },
        ).then(
            (): null => null,
            (caught: unknown): unknown => caught,
        );
        expect(failure).toMatchObject({ code: 3 });
        expect(String(Reflect.get(Object(failure), 'stderr'))).toContain('damaged');
    },
    120000,
);

/** The committed product icon. */
function readFileSyncIcon(): Buffer {
    return readFileSync(resolve('assets/windows/nerva-connector.ico'));
}
