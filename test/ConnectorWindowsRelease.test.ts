// SPDX-FileCopyrightText: 2026 Nerva contributors
// SPDX-License-Identifier: LicenseRef-Proprietary

import { execFile } from 'node:child_process';
import { existsSync } from 'node:fs';
import { readFile, readdir, mkdir, writeFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { expect, it } from 'vitest';
import { ConnectorNpmPackage } from '../script/ConnectorNpmPackage.ts';
import { SignaturePurpose } from 'nerva-connector-protocol/identity/IdentityFormat.js';
import {
    ConnectorReleaseFile,
    ConnectorReleasePlatform,
    type ConnectorSignedRelease,
} from '../src/install/ConnectorRelease.js';
import { ConnectorReleaseAssets } from '../src/install/ConnectorReleaseAssets.js';
import { ConnectorReleaseCodec } from '../src/install/ConnectorReleaseCodec.js';
import { ConnectorReleaseInstallation } from '../src/install/ConnectorReleaseInstallation.js';
import { ConnectorWindowsBootstrap } from '../src/install/ConnectorWindowsBootstrap.js';
import { Boundary } from 'nerva-connector-protocol/protocol/Boundary.js';
import { ConnectorReleaseFixture } from './support/ConnectorReleaseFixture.js';

it.skipIf(process.platform !== 'linux')(
    'the generated npm launcher keeps its private control pipe open, sends cancellation and waits for the owned child to finish',
    async (): Promise<void> => {
        await using fixture: ConnectorReleaseFixture = await ConnectorReleaseFixture.create(
            false,
            undefined,
            ConnectorReleasePlatform.Windows,
        );
        const helper: Buffer = Buffer.alloc(512);
        helper.write('MZ');
        await writeFile(join(fixture.directory, 'nerva-connector-bootstrap.exe'), helper, {
            mode: 0o700,
        });
        const launcher: string = join(fixture.directory, 'launcher.cjs');
        await writeFile(
            launcher,
            ConnectorWindowsBootstrap.launcher(
                ConnectorWindowsBootstrap.configuration(
                    fixture.release,
                    fixture.key.publicKey,
                    'https://downloads.example.com/windows/',
                ),
                {
                    bytes: helper.byteLength,
                    sha256: createHash('sha256').update(helper).digest('hex'),
                    sourceSha256: 'a'.repeat(64),
                },
                '0.1.0',
            ),
            { mode: 0o700 },
        );
        const nativeFixture: string = [
            'let input="",configured=false;',
            'const deadline=setTimeout(()=>process.exit(74),3000);',
            'process.stdin.setEncoding("utf8");',
            'process.stdin.on("end",()=>process.exit(75));',
            'process.stdin.on("data",chunk=>{input+=chunk;let end;while((end=input.indexOf("\\n"))>=0){const line=input.slice(0,end);input=input.slice(end+1);if(!configured){const config=JSON.parse(line);configured=true;process.stdout.write(JSON.stringify({arguments:process.argv.slice(1),control:config.control,resume:JSON.parse(config.argumentsJson)})+"\\n");setTimeout(()=>process.kill(process.ppid,"SIGINT"),25);}else if(line==="cancel"){clearTimeout(deadline);setTimeout(()=>{process.stdout.write("owned-child-cleanup-finished\\n");process.exit(0);},50);}else process.exit(76);}});',
        ].join('');
        const harness: string = [
            'const cp=require("node:child_process"),realSpawn=cp.spawn;',
            'cp.spawn=(file,args,options)=>{if(!file.endsWith("nerva-connector-bootstrap.exe")||args.length!==0)throw new Error("Unexpected bootstrap invocation");return realSpawn(process.execPath,["-e",' +
                JSON.stringify(nativeFixture) +
                '],options);};',
            'Object.defineProperty(process,"platform",{value:"win32"});',
            'process.argv=[process.execPath,' +
                JSON.stringify(launcher) +
                ',"connector","install"];',
            'require(' + JSON.stringify(launcher) + ');',
        ].join('');
        let stdout: string | null = null;
        try {
            await promisify(execFile)(process.execPath, ['-e', harness], {
                timeout: 5000,
                maxBuffer: 8192,
                env: { ...process.env, NODE_OPTIONS: '' },
            });
            throw new Error('Expected the caller interruption status');
        } catch (caught: unknown) {
            if (
                !(caught instanceof Error) ||
                !('code' in caught) ||
                caught.code !== 130 ||
                !('stdout' in caught) ||
                typeof caught.stdout !== 'string'
            ) {
                throw caught;
            }
            stdout = caught.stdout;
        }
        expect(stdout).toContain('"arguments":[]');
        expect(stdout).toContain('"control":"stdin-v1"');
        expect(stdout).toContain('"resume":["install"]');
        expect(stdout).toContain('owned-child-cleanup-finished');
        helper[helper.byteLength - 1] = 1;
        await writeFile(join(fixture.directory, 'nerva-connector-bootstrap.exe'), helper);
        await expect(
            promisify(execFile)(process.execPath, ['-e', harness], {
                timeout: 5000,
                maxBuffer: 8192,
                env: { ...process.env, NODE_OPTIONS: '' },
            }),
        ).rejects.toThrow('does not match its reviewed pin');
    },
);

it('the Windows platform is dual-signed with its exact complete native asset set and missing or mixed platform contracts fail closed', async (): Promise<void> => {
    await using fixture: ConnectorReleaseFixture = await ConnectorReleaseFixture.create(
        false,
        undefined,
        ConnectorReleasePlatform.Windows,
    );
    const raw: unknown = JSON.parse(ConnectorReleaseCodec.encode(fixture.release).toString('utf8'));
    expect(ConnectorReleaseCodec.read(raw, fixture.key.publicKey, BigInt(Date.now()))).toEqual(
        fixture.release,
    );
    expect(
        fixture.release.manifest.artifacts.map((artifact): ConnectorReleaseFile => artifact.name),
    ).toEqual(ConnectorReleaseAssets.names(ConnectorReleasePlatform.Windows));
    const value: Readonly<Record<string, unknown>> = Boundary.record(raw, [
        'manifest',
        'signature',
    ]);
    const manifest: Readonly<Record<string, unknown>> = Boundary.record(value['manifest'], [
        'protocol',
        'releaseId',
        'revision',
        'issuedAtMs',
        'expiresAtMs',
        'platform',
        'architecture',
        'artifacts',
        'deployment',
    ]);
    const missing: Record<string, unknown> = { ...manifest };
    delete missing['platform'];
    expect((): ConnectorSignedRelease =>
        ConnectorReleaseCodec.read(
            { manifest: missing, signature: fixture.release.signature },
            fixture.key.publicKey,
            BigInt(Date.now()),
        ),
    ).toThrow();
    for (const candidate of [
        { ...fixture.release.manifest, platform: ConnectorReleasePlatform.Linux },
        { ...fixture.release.manifest, artifacts: fixture.release.manifest.artifacts.slice(0, 7) },
        {
            ...fixture.release.manifest,
            artifacts: [
                ...fixture.release.manifest.artifacts.slice(0, 1),
                {
                    ...fixture.release.manifest.artifacts[1],
                    name: ConnectorReleaseFile.Runtime,
                    sizeBytes: 1n,
                    sha256: 'a'.repeat(64),
                },
                ...fixture.release.manifest.artifacts.slice(2),
            ],
        },
    ]) {
        const altered: ConnectorSignedRelease = {
            manifest: candidate,
            signature: fixture.key.sign(
                SignaturePurpose.Release,
                ConnectorReleaseCodec.payload(candidate),
            ),
        };
        expect((): ConnectorSignedRelease =>
            ConnectorReleaseCodec.read(
                JSON.parse(ConnectorReleaseCodec.encode(altered).toString('utf8')),
                fixture.key.publicKey,
                BigInt(Date.now()),
            ),
        ).toThrow();
    }
    if (process.platform !== 'win32') {
        await expect(
            ConnectorReleaseInstallation.install(
                join(fixture.directory, 'installation.json'),
                new AbortController().signal,
            ),
        ).rejects.toThrow('platform mismatch');
        expect(await readdir(fixture.directory)).not.toContain('installed');
    }
});

it('a Windows trusted bootstrap commits exact release bytes and refuses network-selected or invalid trust configuration', async (): Promise<void> => {
    await using fixture: ConnectorReleaseFixture = await ConnectorReleaseFixture.create(
        false,
        undefined,
        ConnectorReleasePlatform.Windows,
    );
    const configuration: ReturnType<typeof ConnectorWindowsBootstrap.configuration> =
        ConnectorWindowsBootstrap.configuration(
            fixture.release,
            fixture.key.publicKey,
            'https://downloads.example.com/approved/',
        );
    expect(Buffer.from(configuration.manifestBase64, 'base64')).toEqual(
        ConnectorReleaseCodec.encode(fixture.release),
    );
    expect(configuration.releasePublicKey).toBe(fixture.key.publicKey);
    expect(configuration.argumentsJson).toBe('["connect"]');
    expect(configuration.control).toBe('none');
    for (const url of [
        'http://downloads.example.com/',
        'https://user:password@example.com/',
        'https://downloads.example.com/not-directory',
        'https://downloads.example.com/?redirect=other',
    ]) {
        expect((): ReturnType<typeof ConnectorWindowsBootstrap.configuration> =>
            ConnectorWindowsBootstrap.configuration(fixture.release, fixture.key.publicKey, url),
        ).toThrow();
    }
    const bad: Buffer = Buffer.from(fixture.release.signature, 'base64url');
    bad[0] = (bad[0] ?? 0) ^ 1;
    expect((): ReturnType<typeof ConnectorWindowsBootstrap.configuration> =>
        ConnectorWindowsBootstrap.configuration(
            { ...fixture.release, signature: bad.toString('base64url') },
            fixture.key.publicKey,
            configuration.baseUrl,
        ),
    ).toThrow();
    const command: string = ConnectorWindowsBootstrap.command();
    expect(command).toContain('nerva-connector-bootstrap.exe');
    expect(command).toContain('< "%~dp0release-bootstrap.json"');
    expect(command.toLowerCase()).not.toContain('powershell');
    expect(command).not.toContain('%TEMP%');
});

it.skipIf(process.platform !== 'linux' || !existsSync('/usr/bin/mcs'))(
    'the Windows npm package contains only its pinned precompiled bootstrap and launcher, exposes help without execution and prunes retired Linux scripts',
    async (): Promise<void> => {
        await using fixture: ConnectorReleaseFixture = await ConnectorReleaseFixture.create(
            false,
            undefined,
            ConnectorReleasePlatform.Windows,
        );
        await using linux: ConnectorReleaseFixture = await ConnectorReleaseFixture.create();
        const directory: string = join(fixture.directory, 'npm');
        const build: string = join(fixture.directory, 'build');
        await mkdir(build, { mode: 0o700 });
        await ConnectorNpmPackage.prepare(
            directory,
            '0.1.0',
            linux.release,
            linux.key.publicKey,
            'https://downloads.example.com/linux/',
        );
        await ConnectorNpmPackage.prepare(
            directory,
            '0.1.0',
            fixture.release,
            fixture.key.publicKey,
            'https://downloads.example.com/windows/',
            build,
        );
        expect((await readdir(directory)).toSorted()).toEqual([
            'README.md',
            'launcher.cjs',
            'nerva-connector-bootstrap.exe',
            'package.json',
        ]);
        const raw: unknown = JSON.parse(await readFile(join(directory, 'package.json'), 'utf8'));
        const metadata: Readonly<Record<string, unknown>> = Boundary.record(raw, [
            'name',
            'version',
            'description',
            'license',
            'homepage',
            'os',
            'cpu',
            'bin',
            'files',
            'engines',
        ]);
        expect(metadata['name']).toBe('nerva-connector-win32-x64');
        expect(metadata['os']).toEqual(['win32']);
        expect(metadata['cpu']).toEqual(['x64']);
        expect(metadata['bin']).toEqual({ nexa: 'launcher.cjs' });
        expect(await readFile(join(directory, 'README.md'), 'utf8')).toContain(
            'npm i -g nerva-connector-win32-x64',
        );
        const launcher: string = join(directory, 'launcher.cjs');
        const help: Awaited<ReturnType<typeof execFile.__promisify__>> = await promisify(execFile)(
            process.execPath,
            [launcher, '--help'],
            { timeout: 5000, maxBuffer: 8192, env: { ...process.env, NODE_OPTIONS: '' } },
        );
        expect(help.stdout.toString()).toContain('Windows service setup is unavailable');
        const version: Awaited<ReturnType<typeof execFile.__promisify__>> = await promisify(
            execFile,
        )(process.execPath, [launcher, '--version'], {
            timeout: 5000,
            maxBuffer: 8192,
            env: { ...process.env, NODE_OPTIONS: '' },
        });
        expect(version.stdout.toString()).toBe('0.1.0\n');
        await expect(
            promisify(execFile)(process.execPath, [launcher, 'connector', 'status'], {
                timeout: 5000,
                maxBuffer: 8192,
                env: { ...process.env, NODE_OPTIONS: '' },
            }),
        ).rejects.toThrow('declared Windows CPU architecture');
        const packed: Awaited<ReturnType<typeof execFile.__promisify__>> = await promisify(
            execFile,
        )(
            '/usr/bin/npm',
            [
                'pack',
                directory,
                '--dry-run',
                '--json',
                '--ignore-scripts',
                '--cache',
                join(fixture.directory, 'npm-cache'),
            ],
            { timeout: 15000, maxBuffer: 16384, env: { ...process.env, NODE_OPTIONS: '' } },
        );
        const packing: unknown = JSON.parse(packed.stdout.toString());
        const packages: Readonly<Record<string, unknown>> = Boundary.record(packing, [
            'nerva-connector-win32-x64',
        ]);
        const content: Readonly<Record<string, unknown>> = Boundary.record(
            packages['nerva-connector-win32-x64'],
            [
                'id',
                'name',
                'version',
                'size',
                'unpackedSize',
                'shasum',
                'integrity',
                'filename',
                'files',
                'entryCount',
                'bundled',
            ],
        );
        const names: readonly string[] = Boundary.array(content['files'], 4).map(
            (entry: unknown): string =>
                Boundary.text(Boundary.record(entry, ['path', 'size', 'mode'])['path']),
        );
        expect(names.toSorted()).toEqual([
            'README.md',
            'launcher.cjs',
            'nerva-connector-bootstrap.exe',
            'package.json',
        ]);
        expect(content['unpackedSize']).toBeLessThanOrEqual(524288);
        expect(
            (await readdir(directory)).some((name: string): boolean => name.endsWith('.partial')),
        ).toBe(false);
    },
);
