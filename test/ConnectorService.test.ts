// SPDX-FileCopyrightText: 2026 Dacely <business@dacely.com>
// SPDX-License-Identifier: LicenseRef-Proprietary

import { expect, it, vi, type MockInstance } from 'vitest';
import { readFile, writeFile, readdir, mkdir, rename } from 'node:fs/promises';
import { join } from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { ConnectorServiceFixture } from './support/ConnectorServiceFixture.js';
import { ConnectorClient } from '../src/runtime/ConnectorClient.js';
import { ConnectorInstallation } from '../src/install/ConnectorInstallation.js';
import { ConnectorServiceUnit } from '../src/service/ConnectorServiceUnit.js';
import {
    ConnectorServiceScope,
    ConnectorServiceOperation,
    ConnectorServiceActiveState,
    type ConnectorServiceLayout,
} from '../src/service/ConnectorServiceTypes.js';

it('one installation runtime owns a kernel lock even without file/command capabilities; release joins before reuse', async (): Promise<void> => {
    await using fixture: ConnectorServiceFixture = await ConnectorServiceFixture.create();
    const path: string = join(fixture.layout.installationDirectory, 'state', 'device.json');
    const first: ConnectorClient = await ConnectorClient.load(path, (): void => {});
    try {
        await expect(ConnectorClient.load(path, (): void => {})).rejects.toThrow();
    } finally {
        await first[Symbol.asyncDispose]();
    }
    await using second: ConnectorClient = await ConnectorClient.load(path, (): void => {});
    expect(second.identity.configurationFile).toBe(path);
});

it('install, start, stop and remove target one owned unit, preserve exact counters and leave device identity/history intact', async (): Promise<void> => {
    await using fixture: ConnectorServiceFixture = await ConnectorServiceFixture.create();
    const key: string = join(fixture.layout.installationDirectory, 'state', 'device-key.json');
    const before: Buffer = await readFile(key);
    const signal: AbortSignal = new AbortController().signal;
    await fixture.manager.install(signal);
    expect(fixture.active).toBe(false);
    expect(fixture.enabled).toBe(true);
    expect((await fixture.manager.start(signal)).active).toBe(ConnectorServiceActiveState.Active);
    expect((await fixture.manager.status(signal)).restarts).toBe('9007199254740993');
    await fixture.manager.install(signal);
    await fixture.manager.stop(signal);
    expect(fixture.active).toBe(false);
    await fixture.manager.remove(signal);
    await fixture.manager.remove(signal);
    expect(fixture.enabled).toBe(false);
    expect(await readFile(key)).toEqual(before);
    expect(await readdir(fixture.layout.unitDirectory)).toEqual([]);
    expect(await readdir(fixture.layout.installationDirectory)).not.toContain('service-state.json');
});

it('renaming the same physical identity directory cannot bypass the runtime owner', async (): Promise<void> => {
    await using fixture: ConnectorServiceFixture = await ConnectorServiceFixture.create();
    const root: string = fixture.layout.installationDirectory;
    const original: string = join(root, 'state', 'device.json');
    const first: ConnectorClient = await ConnectorClient.load(original, (): void => {});
    try {
        await rename(join(root, 'state'), join(root, 'moved-state'));
        const configuration: string = join(root, 'moved-state', 'device.json');
        const raw: unknown = JSON.parse(await readFile(configuration, 'utf8'));
        if (typeof raw !== 'object' || raw === null) {
            throw new Error('Fixture configuration missing');
        }
        Reflect.set(raw, 'privateKeyFile', join(root, 'moved-state', 'device-key.json'));
        await writeFile(configuration, JSON.stringify(raw));
        await expect(ConnectorClient.load(configuration, (): void => {})).rejects.toThrow();
    } finally {
        await first[Symbol.asyncDispose]();
    }
});

it('lost enable and start acknowledgments resume the same service without another process or identity', async (): Promise<void> => {
    await using fixture: ConnectorServiceFixture = await ConnectorServiceFixture.create();
    const signal: AbortSignal = new AbortController().signal;
    fixture.loseReply = ConnectorServiceOperation.Enable;
    await expect(fixture.manager.install(signal)).rejects.toThrow();
    const original: Buffer = await readFile(fixture.layout.unitFile);
    await fixture.manager.install(signal);
    expect(await readFile(fixture.layout.unitFile)).toEqual(original);
    fixture.loseReply = ConnectorServiceOperation.Start;
    await expect(fixture.manager.start(signal)).rejects.toThrow();
    expect((await fixture.manager.start(signal)).active).toBe(ConnectorServiceActiveState.Active);
    expect(
        fixture.commands.filter((entry): boolean => entry === ConnectorServiceOperation.Start),
    ).toHaveLength(1);
});

it('foreign unit contents and loaded drop-ins cannot be adopted, replaced, stopped or removed', async (): Promise<void> => {
    await using fixture: ConnectorServiceFixture = await ConnectorServiceFixture.create();
    await mkdir(fixture.layout.unitDirectory, { mode: 0o700 });
    const foreign: string = '[Service]\nExecStart=/usr/bin/sleep 3600\n';
    await writeFile(fixture.layout.unitFile, foreign, { mode: 0o600 });
    const signal: AbortSignal = new AbortController().signal;
    await expect(fixture.manager.install(signal)).rejects.toThrow('unregistered');
    expect(fixture.commands).toEqual([]);
    expect(await readFile(fixture.layout.unitFile, 'utf8')).toBe(foreign);
});

it('lost disable acknowledgment resumes original removal after reloading the changed boot links', async (): Promise<void> => {
    await using fixture: ConnectorServiceFixture = await ConnectorServiceFixture.create();
    const signal: AbortSignal = new AbortController().signal;
    await fixture.manager.install(signal);
    fixture.loseReply = ConnectorServiceOperation.Disable;
    await expect(fixture.manager.remove(signal)).rejects.toThrow();
    expect(fixture.needsReload).toBe(true);
    await fixture.manager.remove(signal);
    expect(fixture.needsReload).toBe(false);
    expect(await readdir(fixture.layout.installationDirectory)).not.toContain('service-state.json');
});

it('an active manual runtime prevents service installation; corrupt app bytes still allow stopping the owned service', async (): Promise<void> => {
    await using fixture: ConnectorServiceFixture = await ConnectorServiceFixture.create();
    const signal: AbortSignal = new AbortController().signal;
    const first: ConnectorClient = await ConnectorClient.load(
        join(fixture.layout.installationDirectory, 'state', 'device.json'),
        (): void => {},
    );
    await expect(fixture.manager.install(signal)).rejects.toThrow();
    expect(fixture.commands).toEqual([]);
    await first[Symbol.asyncDispose]();
    await fixture.manager.install(signal);
    await fixture.manager.start(signal);
    fixture.dropInPaths = '/unowned/override.conf';
    await expect(fixture.manager.stop(signal)).rejects.toThrow('foreign');
    expect(fixture.active).toBe(true);
    fixture.dropInPaths = '';
    await writeFile(join(fixture.layout.installationDirectory, 'nerva-connector.mjs'), 'corrupt');
    await expect(fixture.manager.start(signal)).rejects.toThrow();
    await fixture.manager.stop(signal);
    expect(fixture.active).toBe(false);
});

it('committed installation can be verified after its download ticket expires without admitting an expired new release', async (): Promise<void> => {
    await using fixture: ConnectorServiceFixture = await ConnectorServiceFixture.create();
    const clock: MockInstance<() => number> = vi
        .spyOn(Date, 'now')
        .mockReturnValue(Number(fixture.release.release.manifest.expiresAtMs) + 1);
    try {
        expect(
            (
                await ConnectorInstallation.read(
                    fixture.layout.installationDirectory,
                    new AbortController().signal,
                )
            ).enrolled,
        ).toBe(true);
    } finally {
        clock.mockRestore();
    }
});

it('real systemd parser accepts literal quoted paths without shell or environment expansion', async (): Promise<void> => {
    await using fixture: ConnectorServiceFixture = await ConnectorServiceFixture.create();
    const layout: ConnectorServiceLayout = ConnectorServiceUnit.layout(
        fixture.layout.installationDirectory,
        ConnectorServiceScope.System,
    );
    const file: string = join(fixture.release.directory, layout.unitName);
    await writeFile(file, layout.source, { mode: 0o600 });
    await promisify(execFile)('/usr/bin/systemd-analyze', ['verify', file], {
        env: { PATH: '/usr/bin:/bin', LANG: 'C' },
        timeout: 10000,
        maxBuffer: 16384,
    });
    expect(layout.source).toContain('ExecStart=:');
    expect(layout.source).toContain('UnsetEnvironment=NODE_OPTIONS');
    const quoted: ConnectorServiceLayout = ConnectorServiceUnit.layout(
        '/root/literal $HOME %t " quote',
        ConnectorServiceScope.System,
    );
    expect(quoted.source).toContain('literal $HOME %%t \\" quote');
});
