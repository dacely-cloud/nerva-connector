// SPDX-FileCopyrightText: 2026 Dacely <business@dacely.com>
// SPDX-License-Identifier: LicenseRef-Proprietary

import { ConnectorWindowsSources } from '../script/ConnectorWindowsSources.ts';
import { createHash } from 'node:crypto';
import { existsSync } from 'node:fs';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { expect, it, vi, type MockInstance } from 'vitest';
import { ConnectorHostWindowsBuild } from '../script/ConnectorHostWindowsBuild.js';
import { ConnectorWindowsCompiler } from '../script/ConnectorWindowsCompiler.js';
import { HostDesktopCommand } from '../src/host/HostDesktopCommand.js';
import { HostDesktopLimits } from '../src/host/HostDesktopTypes.js';
import { HostDesktopWindows } from '../src/host/HostDesktopWindows.js';
import { Boundary } from 'nerva-connector-protocol/protocol/Boundary.js';
import { WindowsStateArtifactFile } from '../src/windows/WindowsStateArtifactFile.js';
import { WindowsStateBuild } from '../src/windows/WindowsStateBuild.js';
import type { WindowsStateArtifact } from '../src/windows/WindowsStateArtifact.js';

/** Successful pipe delivery is measured by what a real child received, independently of argument serialization. */
it('desktop subprocesses receive a bounded delayed-read payload through stdin without placing it in argv', async (): Promise<void> => {
    const prefix: string = 'private desktop text Ω\n';
    const input: string =
        prefix + 'x'.repeat(HostDesktopLimits.inputBytes - Buffer.byteLength(prefix));
    const script: string = [
        "const {createHash}=require('node:crypto');",
        'const chunks=[];process.stdin.pause();',
        "process.stdin.on('data',chunk=>chunks.push(chunk));",
        "process.stdin.on('end',()=>{const input=Buffer.concat(chunks);",
        "process.stdout.write(JSON.stringify({arguments:process.argv.slice(1),bytes:input.length,sha256:createHash('sha256').update(input).digest('hex')}));});",
        'setTimeout(()=>process.stdin.resume(),50);',
    ].join('');
    const output: Buffer = await HostDesktopCommand.run(
        process.execPath,
        ['-e', script, '--', 'fixed-desktop-fixture'],
        process.env,
        4096,
        input,
    );
    const raw: unknown = JSON.parse(output.toString('utf8'));
    const value: Readonly<Record<string, unknown>> = Boundary.record(raw, [
        'arguments',
        'bytes',
        'sha256',
    ]);
    expect(value['arguments']).toEqual(['fixed-desktop-fixture']);
    expect(value['bytes']).toBe(HostDesktopLimits.inputBytes);
    expect(value['sha256']).toBe(createHash('sha256').update(input).digest('hex'));
    await expect(
        HostDesktopCommand.run(
            'never-spawn-an-over-limit-desktop-request',
            [],
            process.env,
            4096,
            input + 'x',
        ),
    ).rejects.toThrow('pipe limits');
});

it('the Windows driver puts only its fixed mode in argv and sends request JSON as pipe data', async (): Promise<void> => {
    const run: MockInstance<typeof HostDesktopCommand.run> = vi
        .spyOn(HostDesktopCommand, 'run')
        .mockResolvedValue(Buffer.from('{"ok":true}'));
    try {
        const text: string = 'private desktop input Ω';
        const target: string = 'win32:v1:00000000000000ff:0000002a:01dc000000000001:00000037';
        const driver: HostDesktopWindows = new HostDesktopWindows('verified-helper.exe', {});
        await driver.text(text, target);
        expect(run).toHaveBeenCalledWith(
            'verified-helper.exe',
            ['--desktop'],
            {},
            4096,
            JSON.stringify({ operation: 'text', text, target }),
        );
    } finally {
        run.mockRestore();
    }
});

it.skipIf(
    process.platform !== 'linux' || !existsSync('/usr/bin/mcs') || !existsSync('/usr/bin/mono'),
)(
    'the actual native decoder reads escaped text from stdin and the current host helper remains source-pinned',
    async (): Promise<void> => {
        const directory: string = await mkdtemp(join(tmpdir(), 'nerva-desktop-pipe-'));
        try {
            const executable: string = join(directory, 'desktop-pipe-fixture.exe');
            await ConnectorWindowsCompiler.compile({
                sources: [
                    ...ConnectorWindowsSources.desktop,
                    resolve('test/support/HostDesktopPipeFixture.cs'),
                ],
                entrypoint: 'HostDesktopPipeFixture',
                destination: executable,
            });
            const text: string = '\u0001'.repeat(16384);
            const output: Buffer = await HostDesktopCommand.run(
                '/usr/bin/mono',
                [executable, '--desktop'],
                process.env,
                4096,
                JSON.stringify({ operation: 'text', text }),
            );
            const raw: unknown = JSON.parse(output.toString('utf8'));
            const value: Readonly<Record<string, unknown>> = Boundary.record(raw, [
                'arguments',
                'operation',
                'textUtf8Bytes',
                'textSha256',
            ]);
            expect(value['arguments']).toEqual(['--desktop']);
            expect(value['operation']).toBe('text');
            expect(value['textUtf8Bytes']).toBe(16384);
            expect(value['textSha256']).toBe(createHash('sha256').update(text).digest('hex'));
            await expect(
                HostDesktopCommand.run(
                    '/usr/bin/mono',
                    [executable, '--desktop'],
                    process.env,
                    4096,
                    '{broken',
                ),
            ).rejects.toThrow();
            const artifact: WindowsStateArtifact = await ConnectorHostWindowsBuild.build(directory);
            const helper: string = join(directory, 'nerva-connector-host.exe');
            await WindowsStateArtifactFile.verify(helper, artifact);
            expect(
                await WindowsStateBuild.read(join(directory, 'nerva-connector-host.json')),
            ).toEqual(artifact);
            expect(await ConnectorHostWindowsBuild.build(directory)).toEqual(artifact);
            const bytes: Buffer = await readFile(helper);
            bytes[bytes.byteLength - 1] = (bytes[bytes.byteLength - 1] ?? 0) ^ 1;
            await writeFile(helper, bytes);
            await expect(WindowsStateArtifactFile.verify(helper, artifact)).rejects.toThrow(
                'does not match',
            );
        } finally {
            await rm(directory, { recursive: true, force: true });
        }
    },
);
