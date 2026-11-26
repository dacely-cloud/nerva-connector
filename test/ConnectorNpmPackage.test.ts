// SPDX-FileCopyrightText: 2026 Dacely <business@dacely.com>
// SPDX-License-Identifier: LicenseRef-Proprietary

import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { join } from 'node:path';
import { homedir } from 'node:os';
import { mkdir, readFile, readdir, writeFile, rename, symlink, rm } from 'node:fs/promises';
import { expect, it } from 'vitest';
import { ConnectorNpmPackage } from '../script/ConnectorNpmPackage.js';
import { ConnectorReleaseFixture } from './support/ConnectorReleaseFixture.js';
import { Boundary } from 'nerva-connector-protocol/protocol/Boundary.js';

/** Real process invocation avoids the developer checkout's bin or configuration. */
async function command(file: string, args: readonly string[], home: string): Promise<string> {
    const result: Awaited<ReturnType<typeof execFile.__promisify__>> = await promisify(execFile)(
        file,
        [...args],
        {
            env: {
                PATH: '/usr/bin:/bin',
                HOME: home,
                NODE_OPTIONS: '',
                npm_config_cache: join(homedir(), '.npm'),
            },
            timeout: 30000,
            maxBuffer: 32768,
        },
    );
    return result.stdout.toString('utf8');
}

it('npm global install ships only a tiny bootstrap and first use verifies assets without asking for configuration or granting access', async (): Promise<void> => {
    await using fixture: ConnectorReleaseFixture = await ConnectorReleaseFixture.create(true);
    const directory: string = join(fixture.directory, 'npm');
    await ConnectorNpmPackage.prepare(
        directory,
        '0.1.0',
        fixture.release,
        fixture.key.publicKey,
        'https://downloads.example.com/approved/',
    );
    const home: string = join(fixture.directory, 'home');
    await mkdir(home, { mode: 0o700 });
    const dry: unknown = JSON.parse(
        await command(
            '/usr/bin/npm',
            ['pack', directory, '--dry-run', '--ignore-scripts', '--json'],
            home,
        ),
    );
    const packages: Readonly<Record<string, unknown>> = Boundary.record(dry, ['nerva-connector']);
    const packed: Readonly<Record<string, unknown>> = Boundary.record(packages['nerva-connector'], [
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
    ]);
    expect(packed['unpackedSize']).toBeLessThan(32768);
    const files: readonly string[] = Boundary.array(packed['files'], 4).map(
        (raw: unknown): string =>
            Boundary.text(Boundary.record(raw, ['path', 'size', 'mode'])['path']),
    );
    expect(files.toSorted()).toEqual([
        'README.md',
        'install-connector.sh',
        'launcher.sh',
        'package.json',
    ]);
    await command(
        '/usr/bin/npm',
        ['pack', directory, '--ignore-scripts', '--pack-destination', fixture.directory, '--json'],
        home,
    );
    const prefix: string = join(fixture.directory, 'global');
    await command(
        '/usr/bin/npm',
        [
            'install',
            '--global',
            '--prefix',
            prefix,
            '--offline',
            '--no-audit',
            '--no-fund',
            join(fixture.directory, 'nerva-connector-0.1.0.tgz'),
        ],
        home,
    );
    const executable: string = join(prefix, 'bin/nexa');
    expect(await command(executable, ['--help'], home)).toContain(
        'No configuration files or public keys need to be pasted',
    );
    expect(await command(executable, [], home)).toContain('nexa connector');
    await expect(command(executable, ['status'], home)).rejects.toThrow('Use nexa connector');
    expect(await readdir(home)).toEqual([]);
    await rm(directory, { recursive: true });
    const installation: string = join(home, '.local/share/nerva-connector');
    const output: string = await command(
        executable,
        ['connector', 'system-info', '--release-directory', join(fixture.directory, 'assets')],
        home,
    );
    expect(output).toContain('Setting up your connector');
    const lines: readonly string[] = output.trim().split('\n');
    expect(JSON.parse(lines[lines.length - 1] ?? '')).toMatchObject({ platform: 'linux' });
    expect(JSON.parse(await readFile(join(installation, 'pairing.json'), 'utf8'))).toMatchObject({
        verificationUri: fixture.release.manifest.deployment.verificationUri,
        files: null,
        execution: null,
    });
    const key: Buffer = await readFile(join(installation, 'state/device-key.json'));
    await rename(join(fixture.directory, 'assets'), join(fixture.directory, 'offline-unavailable'));
    expect(await command(executable, ['connector', 'status'], home)).toContain(
        'installed but not linked',
    );
    expect(await command(executable, ['connector', 'logout'], home)).toContain(
        'Machine removed from your account',
    );
    expect(await readFile(join(installation, 'state/device-key.json'))).toEqual(key);
    expect(
        (await readdir(join(home, '.local/share'))).filter((name: string): boolean =>
            name.startsWith('.nerva-setup.'),
        ),
    ).toEqual([]);
    const application: string = join(installation, 'nerva-connector.mjs');
    const bytes: Buffer = await readFile(application);
    bytes[0] = 0;
    await writeFile(application, bytes);
    await expect(command(executable, ['connector', 'status'], home)).rejects.toThrow(
        'Release changed',
    );
    expect(await readFile(join(installation, 'state/device-key.json'))).toEqual(key);
}, 60000);

it('missing or unsafe installations and unsupported arguments fail without generating identity or downloading a release', async (): Promise<void> => {
    await using fixture: ConnectorReleaseFixture = await ConnectorReleaseFixture.create();
    const directory: string = join(fixture.directory, 'npm');
    await ConnectorNpmPackage.prepare(
        directory,
        '0.1.0',
        fixture.release,
        fixture.key.publicKey,
        'https://downloads.example.com/approved/',
    );
    const executable: string = join(directory, 'launcher.sh');
    const home: string = join(fixture.directory, 'home');
    await mkdir(home, { mode: 0o700 });
    for (const args of [
        ['connector', 'status'],
        ['exec', 'sh'],
        ['connector', 'connect', '--scope', 'system'],
        ['connector', 'connect', '--directory', '../escape'],
        ['connector', 'connect', '--directory', home + '/./escape'],
    ]) {
        await expect(command(executable, args, home)).rejects.toThrow();
    }
    await symlink(home, join(fixture.directory, 'link'));
    await expect(
        command(
            executable,
            ['connector', 'connect', '--directory', join(fixture.directory, 'link/state')],
            home,
        ),
    ).rejects.toThrow('Symlink installation ancestry');
    expect(await readdir(home)).toEqual([]);
});

it('invalid package versions or signatures cannot prepare a distribution', async (): Promise<void> => {
    await using fixture: ConnectorReleaseFixture = await ConnectorReleaseFixture.create();
    const directory: string = join(fixture.directory, 'npm');
    expect(ConnectorNpmPackage.version('0.1.0-next.1')).toBe('0.1.0-next.1');
    for (const version of [
        '',
        '../escape',
        '0.1.0\n',
        '01.0.0',
        '0.1.0-01',
        '9007199254740992.0.0',
    ]) {
        await expect(
            ConnectorNpmPackage.prepare(
                directory,
                version,
                fixture.release,
                fixture.key.publicKey,
                'https://downloads.example.com/approved/',
            ),
        ).rejects.toThrow();
    }
    const signature: Buffer = Buffer.from(fixture.release.signature, 'base64url');
    signature[0] = (signature[0] ?? 0) ^ 1;
    await expect(
        ConnectorNpmPackage.prepare(
            directory,
            '0.1.0',
            { ...fixture.release, signature: signature.toString('base64url') },
            fixture.key.publicKey,
            'https://downloads.example.com/approved/',
        ),
    ).rejects.toThrow();
    expect(await readdir(fixture.directory)).not.toContain('npm');
});
