// SPDX-FileCopyrightText: 2026 Nerva contributors
// SPDX-License-Identifier: LicenseRef-Proprietary

import { execFile } from 'node:child_process';
import { existsSync } from 'node:fs';
import { mkdir, readFile, readdir, rm, symlink, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { describe, expect, it } from 'vitest';
import { ConnectorLinuxInstaller } from '../script/ConnectorLinuxInstaller.js';
import { ConnectorPosixArchitecture } from '../script/ConnectorPosixPlatform.js';
import { ConnectorLinuxInstallerFixture } from './support/ConnectorLinuxInstallerFixture.js';

describe.skipIf(process.platform !== 'linux')('standalone Linux installer', (): void => {
    it.skipIf(!existsSync('/usr/bin/gio'))(
        'launches a custom path through the actual desktop-entry parser without interpreting path characters',
        async (): Promise<void> => {
            await using fixture: ConnectorLinuxInstallerFixture =
                await ConnectorLinuxInstallerFixture.create();
            const destination: string = join(
                fixture.directory,
                'Programs/Nerva = 50% $HOME "desktop"',
            );
            const receipt: string = join(fixture.directory, 'launched.json');
            await writeFile(
                join(fixture.application, 'nerva-connector.mjs'),
                `import {writeFileSync} from 'node:fs'; writeFileSync(${JSON.stringify(receipt)}, JSON.stringify(process.argv.slice(2)));\n`,
            );
            await fixture.build();
            await promisify(execFile)(
                '/bin/sh',
                [fixture.installer, '--destination', destination],
                {
                    env: {
                        ...process.env,
                        HOME: fixture.directory,
                        NODE_OPTIONS: '--this-option-is-invalid',
                    },
                },
            );
            const desktop: string = join(
                fixture.directory,
                '.local/share/applications/nerva-connector.desktop',
            );
            const entry: string = await readFile(desktop, 'utf8');
            await writeFile(desktop, entry.replace('Terminal=true', 'Terminal=false'));
            await promisify(execFile)('/usr/bin/gio', ['launch', desktop], {
                timeout: 10000,
                env: { ...process.env, NODE_OPTIONS: '--this-option-is-invalid' },
            });
            await expect
                .poll((): Promise<string> => readFile(receipt, 'utf8'))
                .toBe('["connector"]');
        },
    );

    it('installs offline to a custom path and creates a correctly escaped desktop entry without linking or granting access', async (): Promise<void> => {
        await using fixture: ConnectorLinuxInstallerFixture =
            await ConnectorLinuxInstallerFixture.create();
        const destination: string = join(fixture.directory, "Programs/Nerva's 50% $Desktop");
        await promisify(execFile)('/bin/sh', [fixture.installer, '--destination', destination], {
            env: { ...process.env, HOME: fixture.directory },
        });
        expect((await readdir(destination)).sort()).toEqual(
            [...ConnectorLinuxInstaller.files].sort(),
        );
        const launch: Awaited<ReturnType<typeof execFile.__promisify__>> = await promisify(
            execFile,
        )(join(destination, 'nerva-connector'), ['--help']);
        expect(launch.stdout).toBe('["connector","--help"]');
        const desktop: string = await readFile(
            join(fixture.directory, '.local/share/applications/nerva-connector.desktop'),
            'utf8',
        );
        expect(desktop).toContain('Terminal=true');
        expect(desktop).toContain('Nerva\'s 50%% \\\\$Desktop/nerva-connector"');
        expect(await readdir(join(fixture.directory, '.local/share'))).toEqual(['applications']);
    });

    it('replaces only program files during updates and retains the account identity, permissions and history', async (): Promise<void> => {
        await using fixture: ConnectorLinuxInstallerFixture =
            await ConnectorLinuxInstallerFixture.create();
        const destination: string = join(fixture.directory, 'program');
        const state: string = join(fixture.directory, '.local/share/nerva-connector');
        await mkdir(state, { recursive: true, mode: 0o700 });
        const identity: Buffer = Buffer.from('saved account, grant and journal fixture');
        await writeFile(join(state, 'retained.json'), identity, { mode: 0o600 });
        for (const version of ['first', 'updated']) {
            await writeFile(
                join(fixture.application, 'nerva-connector.mjs'),
                `process.stdout.write(${JSON.stringify(version)});\n`,
            );
            await fixture.build();
            await promisify(execFile)('/bin/sh', [
                fixture.installer,
                '--destination',
                destination,
                '--no-shortcuts',
            ]);
            expect((await promisify(execFile)(join(destination, 'nerva-connector'))).stdout).toBe(
                version,
            );
            expect(await readFile(join(state, 'retained.json'))).toEqual(identity);
            expect((await readdir(fixture.directory)).sort()).toEqual([
                '.local',
                'Setup.run',
                'app',
                'program',
            ]);
        }
    });

    it('preserves an unrelated destination and extra user files inside a recognized installation', async (): Promise<void> => {
        await using fixture: ConnectorLinuxInstallerFixture =
            await ConnectorLinuxInstallerFixture.create();
        const destination: string = join(fixture.directory, 'program');
        await mkdir(destination);
        await writeFile(join(destination, 'personal.txt'), 'keep this');
        await expect(
            promisify(execFile)('/bin/sh', [
                fixture.installer,
                '--destination',
                destination,
                '--no-shortcuts',
            ]),
        ).rejects.toThrow();
        expect(await readFile(join(destination, 'personal.txt'), 'utf8')).toBe('keep this');
        await rm(destination, { recursive: true });
        await promisify(execFile)('/bin/sh', [
            fixture.installer,
            '--destination',
            destination,
            '--no-shortcuts',
        ]);
        await writeFile(join(destination, 'personal.txt'), 'keep this too');
        await expect(
            promisify(execFile)('/bin/sh', [
                fixture.installer,
                '--destination',
                destination,
                '--no-shortcuts',
            ]),
        ).rejects.toThrow();
        expect(await readFile(join(destination, 'personal.txt'), 'utf8')).toBe('keep this too');
    });

    it('refuses symlink ancestry without writing through it', async (): Promise<void> => {
        await using fixture: ConnectorLinuxInstallerFixture =
            await ConnectorLinuxInstallerFixture.create();
        const outside: string = join(fixture.directory, 'outside');
        await mkdir(outside);
        await symlink(outside, join(fixture.directory, 'alias'));
        await expect(
            promisify(execFile)('/bin/sh', [
                fixture.installer,
                '--destination',
                join(fixture.directory, 'alias/program'),
                '--no-shortcuts',
            ]),
        ).rejects.toThrow();
        expect(await readdir(outside)).toEqual([]);
    });

    it('rejects paths the Node module loader cannot use before writing an installation', async (): Promise<void> => {
        await using fixture: ConnectorLinuxInstallerFixture =
            await ConnectorLinuxInstallerFixture.create();
        await expect(
            promisify(execFile)('/bin/sh', [
                fixture.installer,
                '--destination',
                join(fixture.directory, 'Nerva\\Connector'),
                '--no-shortcuts',
            ]),
        ).rejects.toThrow('backslash');
        expect((await readdir(fixture.directory)).sort()).toEqual(['Setup.run', 'app']);
    });

    it('rejects damaged and truncated downloads before publishing any executable and cleans its staging and lock', async (): Promise<void> => {
        await using fixture: ConnectorLinuxInstallerFixture =
            await ConnectorLinuxInstallerFixture.create();
        const original: Buffer = await readFile(fixture.installer);
        const damaged: Buffer = Buffer.from(original);
        damaged[damaged.length - 1] = (damaged.at(-1) ?? 0) ^ 1;
        for (const bytes of [damaged, original.subarray(0, original.length - 16)]) {
            await writeFile(fixture.installer, bytes);
            await expect(
                promisify(execFile)('/bin/sh', [
                    fixture.installer,
                    '--destination',
                    join(fixture.directory, 'program'),
                    '--no-shortcuts',
                ]),
            ).rejects.toThrow();
            expect((await readdir(fixture.directory)).sort()).toEqual(['Setup.run', 'app']);
        }
    });

    it('rejects the other processor architecture before unpacking', async (): Promise<void> => {
        await using fixture: ConnectorLinuxInstallerFixture =
            await ConnectorLinuxInstallerFixture.create();
        await fixture.build(
            process.arch === 'arm64'
                ? ConnectorPosixArchitecture.X64
                : ConnectorPosixArchitecture.Arm64,
        );
        await expect(
            promisify(execFile)('/bin/sh', [
                fixture.installer,
                '--destination',
                join(fixture.directory, 'program'),
                '--no-shortcuts',
            ]),
        ).rejects.toThrow();
        expect((await readdir(fixture.directory)).sort()).toEqual(['Setup.run', 'app']);
    });

    it('refuses installed dependencies and symlink product files before compression', async (): Promise<void> => {
        await using fixture: ConnectorLinuxInstallerFixture =
            await ConnectorLinuxInstallerFixture.create();
        await mkdir(join(fixture.application, 'node_modules'));
        await expect(fixture.build()).rejects.toThrow('unexpected files');
        await rm(join(fixture.application, 'node_modules'), { recursive: true });
        await rm(join(fixture.application, 'node'));
        await symlink(process.execPath, join(fixture.application, 'node'));
        await expect(fixture.build()).rejects.toThrow('regular program files');
        expect((await readdir(fixture.directory)).sort()).toEqual(['Setup.run', 'app']);
    });
});
