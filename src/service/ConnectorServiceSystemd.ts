// SPDX-FileCopyrightText: 2026 Dacely <business@dacely.com>
// SPDX-License-Identifier: LicenseRef-Proprietary

import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { lstat } from 'node:fs/promises';
import { ProtectedFiles } from '../local/ProtectedFiles.js';
import { Boundary } from 'nerva-connector-protocol/protocol/Boundary.js';
import {
    ConnectorServiceScope,
    ConnectorServiceOperation,
    ConnectorServiceActiveState,
    ConnectorServiceEnabledState,
    ConnectorServiceLoadState,
    type ConnectorServiceDriver,
    type ConnectorServiceLayout,
    type ConnectorServiceStatus,
} from './ConnectorServiceTypes.js';

/** Local D-Bus clients use trusted executables, finite output/time limits and a fixed manager; no shell or caller-selected bus is used. */
export class ConnectorServiceSystemd implements ConnectorServiceDriver {
    /** Offline parsing must succeed before the unit is enabled. */
    public async verify(layout: ConnectorServiceLayout, signal: AbortSignal): Promise<void> {
        await this.#exec(
            '/usr/bin/systemd-analyze',
            [...this.#scope(layout), 'verify', layout.unitFile],
            layout,
            signal,
        );
    }
    /** Exact idempotent unit operations may outlive a disconnected observer; durable local intent controls recovery. */
    public async command(
        action: ConnectorServiceOperation,
        layout: ConnectorServiceLayout,
        signal: AbortSignal,
    ): Promise<void> {
        const args: readonly string[] =
            action === ConnectorServiceOperation.Reload
                ? ['daemon-reload']
                : action === ConnectorServiceOperation.Enable
                  ? ['enable', '--no-reload', layout.unitName]
                  : action === ConnectorServiceOperation.Disable
                    ? ['disable', '--no-reload', layout.unitName]
                    : action === ConnectorServiceOperation.Start
                      ? ['reset-failed', layout.unitName]
                      : [];
        if (action === ConnectorServiceOperation.Start) {
            await this.#exec(
                '/usr/bin/systemctl',
                [...this.#scope(layout), ...args],
                layout,
                signal,
            );
            await this.#exec(
                '/usr/bin/systemctl',
                [...this.#scope(layout), 'start', layout.unitName],
                layout,
                signal,
            );
        } else if (action === ConnectorServiceOperation.Stop) {
            await this.#exec(
                '/usr/bin/systemctl',
                [...this.#scope(layout), 'stop', layout.unitName],
                layout,
                signal,
            );
        } else if (args.length !== 0) {
            await this.#exec(
                '/usr/bin/systemctl',
                [...this.#scope(layout), ...args],
                layout,
                signal,
            );
        } else {
            throw new Error('Unsupported local service manager operation');
        }
    }
    /** State is separate from cloud online presence; unexpected manager fields or quantities are rejected. */
    public async status(
        layout: ConnectorServiceLayout,
        signal: AbortSignal,
    ): Promise<ConnectorServiceStatus> {
        const fields: readonly string[] = [
            'LoadState',
            'ActiveState',
            'UnitFileState',
            'MainPID',
            'NRestarts',
            'FragmentPath',
            'DropInPaths',
            'NeedDaemonReload',
        ];
        const output: string = await this.#exec(
            '/usr/bin/systemctl',
            [
                ...this.#scope(layout),
                'show',
                '--all',
                '--no-pager',
                '--property=' + fields.join(','),
                layout.unitName,
            ],
            layout,
            signal,
            true,
        );
        const values: Map<string, string> = new Map();
        for (const line of output.trimEnd().split('\n')) {
            const index: number = line.indexOf('=');
            const name: string = line.slice(0, index);
            if (index < 0 || !fields.includes(name) || values.has(name)) {
                throw new Error('Invalid local service status');
            }
            values.set(name, line.slice(index + 1));
        }
        const get: (name: string) => string = (name: string): string => {
            const entry: string | undefined = values.get(name);
            if (entry === undefined) {
                throw new Error('Missing local service status');
            }
            return entry;
        };
        const load: ConnectorServiceLoadState | undefined = Object.values(
            ConnectorServiceLoadState,
        ).find((entry): boolean => entry.valueOf() === get('LoadState'));
        const active: ConnectorServiceActiveState | undefined = Object.values(
            ConnectorServiceActiveState,
        ).find((entry): boolean => entry.valueOf() === get('ActiveState'));
        const enabled: ConnectorServiceEnabledState | undefined = Object.values(
            ConnectorServiceEnabledState,
        ).find((entry): boolean => entry.valueOf() === get('UnitFileState'));
        if (load === ConnectorServiceLoadState.NotFound) {
            if (
                active !== ConnectorServiceActiveState.Inactive ||
                get('FragmentPath') !== '' ||
                get('DropInPaths') !== '' ||
                get('NeedDaemonReload') !== 'no' ||
                !['', '0'].includes(values.get('MainPID') ?? '')
            ) {
                throw new Error('Conflicting absent service status');
            }
            return {
                scope: layout.scope,
                unitName: layout.unitName,
                load,
                active,
                enabled: enabled ?? ConnectorServiceEnabledState.Absent,
                mainPid: null,
                restarts: null,
                fragmentPath: '',
                dropInPaths: '',
                needsReload: false,
            };
        }
        const pid: bigint = Boundary.integer(get('MainPID'));
        const restarts: string = get('NRestarts');
        Boundary.integer(restarts);
        const reload: string = get('NeedDaemonReload');
        if (
            load === undefined ||
            active === undefined ||
            enabled === undefined ||
            pid > 2147483647n ||
            !['yes', 'no'].includes(reload)
        ) {
            throw new Error('Unsupported local service status');
        }
        return {
            scope: layout.scope,
            unitName: layout.unitName,
            load,
            active,
            enabled,
            mainPid: Number(pid),
            restarts,
            fragmentPath: get('FragmentPath'),
            dropInPaths: get('DropInPaths'),
            needsReload: reload === 'yes',
        };
    }
    #scope(layout: ConnectorServiceLayout): readonly string[] {
        return layout.scope === ConnectorServiceScope.User ? ['--user'] : [];
    }
    async #exec(
        executable: string,
        args: readonly string[],
        layout: ConnectorServiceLayout,
        signal: AbortSignal,
        missing: boolean = false,
    ): Promise<string> {
        await ProtectedFiles.directory('/usr/bin');
        const binary: Awaited<ReturnType<typeof lstat>> = await lstat(executable);
        if (!binary.isFile() || binary.uid !== 0 || (binary.mode & 0o6022) !== 0) {
            throw new Error('Trusted systemd executable required');
        }
        const environment: NodeJS.ProcessEnv = { PATH: '/usr/bin:/bin', LANG: 'C', LC_ALL: 'C' };
        if (layout.scope === ConnectorServiceScope.User) {
            const directory: string = '/run/user/' + String(process.getuid?.());
            await ProtectedFiles.directory(directory);
            const state: Awaited<ReturnType<typeof lstat>> = await lstat(directory);
            if (state.uid !== process.getuid?.() || (state.mode & 0o077) !== 0) {
                throw new Error('A private current-user systemd session is required');
            }
            environment['XDG_RUNTIME_DIR'] = directory;
            environment['DBUS_SESSION_BUS_ADDRESS'] = 'unix:path=' + directory + '/bus';
        }
        try {
            const result: Awaited<ReturnType<typeof execFile.__promisify__>> = await promisify(
                execFile,
            )(executable, [...args], {
                env: environment,
                signal,
                timeout: 60000,
                maxBuffer: 32768,
            });
            return result.stdout.toString();
        } catch (caught: unknown) {
            signal.throwIfAborted();
            if (
                missing &&
                caught instanceof Error &&
                'code' in caught &&
                caught.code === 4 &&
                'stdout' in caught &&
                (typeof caught.stdout === 'string' || Buffer.isBuffer(caught.stdout))
            ) {
                return caught.stdout.toString();
            }
            throw new Error('Local service manager operation failed', { cause: caught });
        }
    }
}
