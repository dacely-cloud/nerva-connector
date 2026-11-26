// SPDX-FileCopyrightText: 2026 Dacely <business@dacely.com>
// SPDX-License-Identifier: LicenseRef-Proprietary

import { execFile, fork, type ChildProcess } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { isBuiltin } from 'node:module';
import { existsSync } from 'node:fs';
import { mkdtemp, rm } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join, resolve } from 'node:path';
import { promisify } from 'node:util';
import { rolldown, type RolldownBuild } from 'rolldown';
import { expect, it, vi, type MockInstance } from 'vitest';
import { Boundary } from 'nerva-connector-protocol/protocol/Boundary.js';
import { ConnectorConsole } from '../src/cli/ConnectorConsole.js';
import type { ConnectorConsoleChoice } from '../src/cli/ConnectorConsoleScreen.js';
import { ConnectorConsoleModel } from '../src/cli/ConnectorConsoleModel.js';
import { HostDesktopCommand } from '../src/host/HostDesktopCommand.js';
import { HostWindowsBuild } from '../src/host/HostWindowsBuild.js';
import { WindowsBackgroundUpdate } from '../src/windows/WindowsBackgroundUpdate.js';
import {
    ConnectorUpdateMessage,
    ConnectorUpdateStatus,
} from '../src/update/ConnectorUpdateMessage.js';
import { ConnectorWindowsCompiler } from '../script/ConnectorWindowsCompiler.ts';
import { ConnectorWindowsSources } from '../script/ConnectorWindowsSources.ts';

const event: string = 'Local\\NervaConnector.Update.' + 'a'.repeat(32);
const supervisor: string = 'C:\\Users\\fixture\\Programs\\Nerva Connector\\Nerva Connector.exe';

it('offers /update for installed Windows, Mac and Linux launchers and leaves source checkouts without installation authority', (): void => {
    for (const platform of ['win32', 'darwin', 'linux'] as const) {
        const model: ConnectorConsoleModel = new ConnectorConsoleModel();
        expect(ConnectorConsole.choices('/update', model, platform)).toHaveLength(0);
        model.updates = true;
        expect(
            ConnectorConsole.choices('/update', model, platform).map(
                (choice: ConnectorConsoleChoice): string => choice.command,
            ),
        ).toEqual(['update']);
    }
});

it('IPC status input cannot call accessors or inherit an update action', (): void => {
    let invoked: boolean = false;
    const accessor: Readonly<Record<string, string>> = {
        get nervaConnectorUpdate(): string {
            invoked = true;
            return 'check';
        },
    };
    expect(ConnectorUpdateMessage.read(accessor)).toBeNull();
    expect(invoked).toBe(false);
    expect(
        ConnectorUpdateMessage.read(Object.create({ nervaConnectorUpdate: 'check' })),
    ).toBeNull();
    expect(
        ConnectorUpdateMessage.read({ nervaConnectorUpdate: 'check', [Symbol('hidden')]: true }),
    ).toBeNull();
});

it('Windows requests only its SHA-pinned helper and reserved event, never an executable selected by environment', async (): Promise<void> => {
    const adapter: WindowsBackgroundUpdate | null = WindowsBackgroundUpdate.find(
        'win32',
        { NERVA_CONNECTOR_SUPERVISOR: supervisor, NERVA_CONNECTOR_UPDATE_EVENT: event },
        (): boolean => true,
    );
    expect(adapter).not.toBeNull();
    if (adapter === null) {
        throw new Error('Expected installed fixture updater');
    }
    for (const environment of [
        { NERVA_CONNECTOR_SUPERVISOR: supervisor },
        {
            NERVA_CONNECTOR_SUPERVISOR: supervisor,
            NERVA_CONNECTOR_UPDATE_EVENT: 'Local\\OtherEvent',
        },
        { NERVA_CONNECTOR_SUPERVISOR: 'arbitrary.exe', NERVA_CONNECTOR_UPDATE_EVENT: event },
    ]) {
        expect(WindowsBackgroundUpdate.find('win32', environment, (): boolean => true)).toBeNull();
    }
    const verified: MockInstance<typeof HostWindowsBuild.verifiedExecutable> = vi
        .spyOn(HostWindowsBuild, 'verifiedExecutable')
        .mockResolvedValue('verified-fixed-helper.exe');
    const run: MockInstance<typeof HostDesktopCommand.run> = vi
        .spyOn(HostDesktopCommand, 'run')
        .mockResolvedValue(Buffer.from('current\n'));
    try {
        expect(await adapter.check(new AbortController().signal)).toBe(
            ConnectorUpdateStatus.Current,
        );
        expect(verified).toHaveBeenCalledTimes(1);
        expect(run).toHaveBeenCalledTimes(1);
        const call: Parameters<typeof HostDesktopCommand.run> | undefined = run.mock.calls[0];
        expect(call?.[0]).toBe('verified-fixed-helper.exe');
        expect(call?.[1]).toEqual(['--connector-update', event]);
        expect(call?.[3]).toBe(4096);
        run.mockResolvedValueOnce(Buffer.from('failed\n'));
        expect(await adapter.check(new AbortController().signal)).toBe(
            ConnectorUpdateStatus.Failed,
        );
        run.mockResolvedValueOnce(Buffer.from('current\nother output'));
        await expect(adapter.check(new AbortController().signal)).rejects.toThrow('unknown status');
        verified.mockRejectedValueOnce(new Error('Untrusted helper'));
        await expect(adapter.check(new AbortController().signal)).rejects.toThrow(
            'Untrusted helper',
        );
        expect(run).toHaveBeenCalledTimes(3);
        const stop: AbortController = new AbortController();
        stop.abort();
        await expect(adapter.check(stop.signal)).rejects.toThrow();
        expect(verified).toHaveBeenCalledTimes(4);
    } finally {
        verified.mockRestore();
        run.mockRestore();
    }
});

it('the actual private Node IPC channel forwards /update and accepts only fixed status messages', async (): Promise<void> => {
    const directory: string = await mkdtemp(join(homedir(), 'nerva-update-command-'));
    let child: ChildProcess | null = null;
    try {
        const executable: string = join(directory, 'channel.mjs');
        const bundle: RolldownBuild = await rolldown({
            input: resolve('test/support/ConnectorUpdateChannelFixture.ts'),
            platform: 'node',
            external: (id: string): boolean => isBuiltin(id),
        });
        try {
            await bundle.write({ file: executable, format: 'esm', codeSplitting: false });
        } finally {
            await bundle.close();
        }
        const completed: PromiseWithResolvers<number | null> = Promise.withResolvers<
            number | null
        >();
        child = fork(executable, [], {
            execArgv: [],
            stdio: ['ignore', 'pipe', 'pipe', 'ipc'],
            env: {
                ...process.env,
                NERVA_CONNECTOR_SUPERVISOR: '',
                NERVA_CONNECTOR_UPDATE_EVENT: '',
            },
        });
        const active: ChildProcess = child;
        let output: string = '';
        let rows: readonly string[] | null = null;
        active.stdout?.setEncoding('utf8');
        active.stdout?.on('data', (value: string): void => {
            output += value;
        });
        active.stderr?.resume();
        active.once('error', completed.reject);
        active.once('close', completed.resolve);
        active.on('message', (raw: unknown): void => {
            if (ConnectorUpdateMessage.read(raw) === ConnectorUpdateStatus.Check) {
                active.send({ nervaConnectorUpdate: 'current', injected: 'untrusted text' });
                active.send({ nervaConnectorUpdate: 'current' });
            } else {
                const probe: Readonly<Record<string, unknown>> = Boundary.record(raw, ['rows']);
                rows = Boundary.array(probe['rows'], 4).map((value: unknown): string => {
                    if (typeof value !== 'string') {
                        throw new Error('Invalid probe row');
                    }
                    return value;
                });
            }
        });
        expect(await completed.promise).toBe(0);
        expect(rows).toEqual(['Nerva Connector is up to date.']);
        expect(output).toContain('channel-closed');
    } finally {
        if (child !== null && child.exitCode === null && child.signalCode === null) {
            const stopped: PromiseWithResolvers<undefined> = Promise.withResolvers<undefined>();
            child.once('close', (): void => stopped.resolve(undefined));
            child.kill('SIGKILL');
            await stopped.promise;
        }
        await rm(directory, { recursive: true, force: true });
    }
}, 15000);

it.skipIf(
    process.platform !== 'win32' && !(process.platform === 'linux' && existsSync('/usr/bin/mcs')),
)(
    'the compiled native update action rejects arbitrary names and signals only an owned random Windows event',
    async (): Promise<void> => {
        const directory: string = await mkdtemp(join(homedir(), 'nerva-update-native-'));
        try {
            const executable: string = join(directory, 'update.exe');
            await ConnectorWindowsCompiler.compile({
                sources: [
                    ...ConnectorWindowsSources.host,
                    resolve('test/support/WindowsUpdateCommandFixture.cs'),
                ],
                entrypoint: 'NexaConnectorUpdateCommandFixture',
                destination: executable,
            });
            const result: Awaited<ReturnType<typeof execFile.__promisify__>> = await promisify(
                execFile,
            )(
                process.platform === 'win32' ? executable : '/usr/bin/mono',
                process.platform === 'win32'
                    ? [
                          '--native',
                          'Local\\NervaConnector.Update.' + randomUUID().replaceAll('-', ''),
                      ]
                    : [executable],
                { timeout: 10000, maxBuffer: 4096 },
            );
            expect(result.stdout.toString()).toContain('bounded_update_names=true');
            if (process.platform === 'win32') {
                expect(result.stdout.toString().split(/\r?\n/u)).toContain('current');
                expect(result.stdout.toString()).toContain('native_update_dispatch=true');
            }
        } finally {
            await rm(directory, { recursive: true, force: true });
        }
    },
    30000,
);
