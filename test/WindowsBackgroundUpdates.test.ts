// SPDX-FileCopyrightText: 2026 Dacely <business@dacely.com>
// SPDX-License-Identifier: LicenseRef-Proprietary

import { execFile } from 'node:child_process';
import { generateKeyPairSync } from 'node:crypto';
import { existsSync } from 'node:fs';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { promisify } from 'node:util';
import { afterEach, beforeEach, expect, it } from 'vitest';
import { ConnectorConsole } from '../src/cli/ConnectorConsole.js';
import { ConnectorConsoleModel } from '../src/cli/ConnectorConsoleModel.js';
import type { ConnectorConsoleChoice } from '../src/cli/ConnectorConsoleScreen.js';
import { WindowsBackgroundStartup } from '../src/windows/WindowsBackgroundStartup.js';
import { ConnectorWindowsCompiler } from '../script/ConnectorWindowsCompiler.ts';
import { ConnectorWindowsInstaller } from '../script/ConnectorWindowsInstaller.ts';
import { ConnectorWindowsUpdateFeed } from '../script/ConnectorWindowsUpdateFeed.ts';

/** Mono runs the installed program's own C# update check against feeds the release script signed. */
const mono: boolean =
    process.platform === 'linux' && existsSync('/usr/bin/mcs') && existsSync('/usr/bin/mono');

/** A release key pair in PEM. */
interface ReleaseKey {
    readonly publicKey: string;
    readonly privateKey: string;
}

let directory: string = '';

beforeEach(async (): Promise<void> => {
    directory = await mkdtemp(join(tmpdir(), 'nerva-connector-updates-'));
});

afterEach(async (): Promise<void> => {
    await rm(directory, { recursive: true, force: true });
});

function key(bits: number): ReleaseKey {
    return generateKeyPairSync('rsa', {
        modulusLength: bits,
        publicKeyEncoding: { type: 'spki', format: 'pem' },
        privateKeyEncoding: { type: 'pkcs8', format: 'pem' },
    });
}

/** Signs a feed offering `version` for x64 into its own directory. */
async function feed(name: string, version: string, signer: ReleaseKey): Promise<string> {
    const output: string = join(directory, name);
    await mkdir(output);
    const setup: string = join(directory, `Nerva-Connector-Setup-${version}-x64.exe`);
    await writeFile(setup, Buffer.from('MZ setup ' + version));
    await ConnectorWindowsUpdateFeed.write(
        output,
        version,
        [{ architecture: 'x64', path: setup }],
        signer.privateKey,
    );
    return output;
}

/** Runs the C# check: "current", "invalid" or "<version> <file> <size> <sha256>". */
async function check(
    reader: string,
    output: string,
    trusted: ReleaseKey,
    architecture: string,
    installed: string,
): Promise<string> {
    const keyFile: string = join(output, 'key.xml');
    await writeFile(keyFile, ConnectorWindowsUpdateFeed.publicKeyXml(trusted.publicKey));
    const result: { readonly stdout: string } = await promisify(execFile)(
        '/usr/bin/mono',
        [
            reader,
            join(output, 'latest.json'),
            join(output, 'latest.json.sig'),
            keyFile,
            architecture,
            installed,
        ],
        { timeout: 60000 },
    );
    return result.stdout.trim();
}

it.skipIf(!mono)(
    'installed copies accept only a strictly newer feed signed by their release key',
    async (): Promise<void> => {
        const reader: string = join(directory, 'reader.exe');
        await ConnectorWindowsCompiler.compile({
            sources: [
                resolve('test/support/WindowsUpdateFeedFixture.cs'),
                resolve('native/windows/installer/UpdateFeed.cs'),
            ],
            entrypoint: 'NexaConnectorUpdateFeedFixture',
            destination: reader,
        });
        const release: ReleaseKey = key(3072);
        const newer: string = await feed('newer', '1.4.0', release);
        const signed: string = await readFile(join(newer, 'latest.json'), 'utf8');
        expect(signed).not.toMatch(/[\r\n]/u);
        const latest: unknown = JSON.parse(signed);
        expect(latest).toMatchObject({
            product: 'nerva-connector-windows',
            version: '1.4.0',
            files: { x64: { name: 'Nerva-Connector-Setup-1.4.0-x64.exe', size: '14' } },
        });
        expect(await check(reader, newer, release, 'x64', '1.3.9')).toMatch(
            /^1\.4\.0 Nerva-Connector-Setup-1\.4\.0-x64\.exe 14 [0-9a-f]{64}$/u,
        );
        expect(await check(reader, newer, release, 'x64', '1.4.0')).toBe('current');
        expect(await check(reader, newer, release, 'x64', '1.10.0')).toBe('current');
        expect(await check(reader, newer, release, 'arm64', '1.0.0')).toBe('current');
        expect(await check(reader, newer, key(3072), 'x64', '1.0.0')).toBe('invalid');
        const tampered: string = await feed('tampered', '1.4.0', release);
        const bytes: Buffer = await readFile(join(tampered, 'latest.json'));
        await writeFile(
            join(tampered, 'latest.json'),
            Buffer.from(bytes.toString('utf8').replace('1.4.0', '9.4.0')),
        );
        expect(await check(reader, tampered, release, 'x64', '1.0.0')).toBe('invalid');
        const converted: string = await feed('converted', '1.4.0', release);
        const signature: string = await readFile(join(converted, 'latest.json.sig'), 'utf8');
        await writeFile(join(converted, 'latest.json.sig'), signature.replace(/\n/gu, '\r\n'));
        expect(await check(reader, converted, release, 'x64', '1.3.9')).toMatch(/^1\.4\.0 /u);
        const weak: ReleaseKey = key(2048);
        expect((): string => ConnectorWindowsUpdateFeed.publicKeyXml(weak.publicKey)).toThrow(
            '3072',
        );
    },
    180000,
);

it('the update settings compiled into the background program accept only checked values', (): void => {
    const release: ReleaseKey = key(3072);
    const settings: string = ConnectorWindowsInstaller.settings({
        version: '1.2.3',
        architecture: 'arm64',
        updates: {
            feedUrl: 'https://downloads.example.com/connector/windows/',
            publicKeyXml: ConnectorWindowsUpdateFeed.publicKeyXml(release.publicKey),
        },
    });
    expect(settings).toContain('internal const string Architecture = "arm64";');
    expect(settings).toContain('"https://downloads.example.com/connector/windows/"');
    expect(
        ConnectorWindowsInstaller.settings({
            version: '1.2.3',
            architecture: 'x64',
            updates: null,
        }),
    ).toContain('internal const string FeedUrl = "";');
    for (const feedUrl of [
        'http://downloads.example.com/',
        'https://downloads.example.com/latest',
        'https://downloads.example.com/"; System.Diagnostics.Process.Start("x"); "/',
    ]) {
        expect((): string =>
            ConnectorWindowsInstaller.settings({
                version: '1.2.3',
                architecture: 'x64',
                updates: { feedUrl, publicKeyXml: '' },
            }),
        ).toThrow('Invalid Windows update settings');
    }
});

it('the startup setting and /startup exist only for the connector the installed Windows program started', (): void => {
    const program: string =
        'C:\\Users\\ada\\AppData\\Local\\Programs\\Nerva Connector\\Nerva Connector.exe';
    const present: () => boolean = (): boolean => true;
    expect(
        WindowsBackgroundStartup.find('win32', { NERVA_CONNECTOR_SUPERVISOR: program }, present)
            ?.program,
    ).toBe(program);
    expect(
        WindowsBackgroundStartup.find('linux', { NERVA_CONNECTOR_SUPERVISOR: program }, present),
    ).toBeNull();
    expect(WindowsBackgroundStartup.find('win32', {}, present)).toBeNull();
    expect(
        WindowsBackgroundStartup.find(
            'win32',
            { NERVA_CONNECTOR_SUPERVISOR: 'C:\\Temp\\other.exe' },
            present,
        ),
    ).toBeNull();
    expect(
        WindowsBackgroundStartup.find(
            'win32',
            { NERVA_CONNECTOR_SUPERVISOR: 'Nerva Connector.exe' },
            present,
        ),
    ).toBeNull();
    const model: ConnectorConsoleModel = new ConnectorConsoleModel();
    const offered: () => readonly string[] = (): readonly string[] =>
        ConnectorConsole.choices('/st', model, 'win32').map(
            (choice: ConnectorConsoleChoice): string => choice.command,
        );
    expect(offered()).not.toContain('startup');
    model.startup = false;
    expect(offered()).toContain('startup');
});
