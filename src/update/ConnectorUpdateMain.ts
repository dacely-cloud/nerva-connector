// SPDX-FileCopyrightText: 2026 Nerva contributors
// SPDX-License-Identifier: LicenseRef-Proprietary

import { homedir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { ConnectorConnectionLog } from '../runtime/ConnectorConnectionLog.js';
import { ConnectorUpdateBuildSettings } from './ConnectorUpdateBuildSettings.js';
import { ConnectorUpdateLock } from './ConnectorUpdateLock.js';
import { ConnectorUpdatePackage } from './ConnectorUpdatePackage.js';
import { ConnectorUpdatePaths } from './ConnectorUpdatePaths.js';
import { ConnectorUpdateSupervisor } from './ConnectorUpdateSupervisor.js';
import { ConnectorUpdateTransaction } from './ConnectorUpdateTransaction.js';
import {
    ConnectorUpdatePlatform,
    type ConnectorUpdateSettings,
} from './ConnectorUpdateProtocol.js';

/** Only the installed launcher enters supervision; ordinary CLI commands remain finite and do not check the network. */
const settings: ConnectorUpdateSettings = ConnectorUpdateBuildSettings.read();
const directory: string = dirname(fileURLToPath(import.meta.url));
const arguments_: readonly string[] = process.argv.slice(2);
if (process.execve === undefined) {
    throw new Error('Automatic updates require the bundled POSIX Node runtime');
}
if (arguments_.length === 1 && arguments_[0] === '--version') {
    process.stdout.write(settings.version + '\n');
} else if (arguments_.length !== 0) {
    process.execve(
        join(directory, 'node'),
        [
            join(directory, 'node'),
            join(directory, 'nerva-connector.mjs'),
            'connector',
            ...arguments_,
        ],
        ConnectorUpdatePackage.environment(),
    );
} else {
    const stop: AbortController = new AbortController();
    const interrupt: () => void = (): void => stop.abort();
    process.once('SIGINT', interrupt);
    process.once('SIGTERM', interrupt);
    const log: ConnectorConnectionLog = new ConnectorConnectionLog(
        join(dirname(ConnectorConnectionLog.location()), 'updater.log'),
    );
    const root: string =
        settings.platform === ConnectorUpdatePlatform.Mac
            ? resolve(directory, '../../..')
            : directory;
    await using transaction: ConnectorUpdateTransaction = new ConnectorUpdateTransaction(
        root,
        settings,
    );
    let lease: ConnectorUpdateLock | null = null;
    try {
        const state: string = join(homedir(), '.local/state/nerva-connector-updates');
        await ConnectorUpdatePaths.create(state);
        lease = await ConnectorUpdateLock.acquire(
            join(directory, 'nerva-connector-update'),
            join(state, 'supervisor.lock'),
            settings,
        );
        await transaction.recover();
        const updated: boolean = await new ConnectorUpdateSupervisor(
            directory,
            settings,
            transaction,
            log,
        ).run(stop.signal);
        if (updated && !stop.signal.aborted) {
            transaction.retainForRestart();
            await lease[Symbol.asyncDispose]();
            lease = null;
            await log.flush();
            try {
                if (stop.signal.aborted) {
                    await transaction.rollback();
                } else {
                    process.execve(
                        join(directory, 'node'),
                        [join(directory, 'node'), join(directory, 'nerva-connector-update.mjs')],
                        ConnectorUpdatePackage.environment(),
                    );
                }
            } catch (caught: unknown) {
                await transaction.rollback();
                throw caught;
            }
        }
    } catch (caught: unknown) {
        log.record('update-supervisor-failed', { reason: ConnectorConnectionLog.error(caught) });
        process.stderr.write(
            'Nerva Connector could not start its update supervisor. See updater.log beside the connection log.\n',
        );
        process.exitCode = 1;
    } finally {
        await lease?.[Symbol.asyncDispose]();
        await log.flush();
        process.removeListener('SIGINT', interrupt);
        process.removeListener('SIGTERM', interrupt);
    }
}
