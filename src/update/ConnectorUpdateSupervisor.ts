// SPDX-FileCopyrightText: 2026 Nerva contributors
// SPDX-License-Identifier: LicenseRef-Proprietary

import { fork, type ChildProcess } from 'node:child_process';
import { join } from 'node:path';
import { ConnectorConnectionLog } from '../runtime/ConnectorConnectionLog.js';
import { ConnectorUpdateDownload } from './ConnectorUpdateDownload.js';
import { ConnectorUpdatePackage } from './ConnectorUpdatePackage.js';
import { ConnectorUpdateTransaction } from './ConnectorUpdateTransaction.js';
import type { ConnectorUpdateRelease, ConnectorUpdateSettings } from './ConnectorUpdateProtocol.js';
import {
    ConnectorUpdateMessage,
    ConnectorUpdateStatus,
    type ConnectorUpdatePacket,
} from './ConnectorUpdateMessage.js';

/** One owner keeps the console responsive while checking signed releases, then drains it before swapping programs. */
export class ConnectorUpdateSupervisor {
    #child: ChildProcess | null = null;
    #ended: PromiseWithResolvers<number> = Promise.withResolvers<number>();
    #wake: (() => void) | null = null;
    #pending: boolean = false;
    #closed: boolean = false;

    /** The installed runtime and program directory are independent of the connector's private account state. */
    public constructor(
        public readonly directory: string,
        public readonly settings: ConnectorUpdateSettings,
        public readonly transaction: ConnectorUpdateTransaction,
        public readonly log: ConnectorConnectionLog,
    ) {}

    /** Returns true only after a verified update was installed and the caller must exec the new supervisor. */
    public async run(signal: AbortSignal): Promise<boolean> {
        this.#start();
        let delay: number = 60000;
        try {
            while (!signal.aborted) {
                const event: string = await this.#wait(delay, signal);
                if (event === 'exit') {
                    process.exitCode = await this.#ended.promise;
                    return false;
                }
                if (signal.aborted) {
                    break;
                }
                if (await this.#check(signal)) {
                    return true;
                }
                delay = 3600000;
            }
            return false;
        } finally {
            if (!this.#closed && !(await this.#stopChild(30000))) {
                this.#child?.kill('SIGKILL');
                await this.#ended.promise;
            }
        }
    }

    #start(): void {
        this.#closed = false;
        this.#ended = Promise.withResolvers<number>();
        const child: ChildProcess = fork(
            join(this.directory, 'nerva-connector.mjs'),
            ['connector'],
            {
                execPath: join(this.directory, 'node'),
                execArgv: [],
                stdio: ['inherit', 'inherit', 'inherit', 'ipc'],
                env: ConnectorUpdatePackage.environment(),
            },
        );
        this.#child = child;
        child.once('error', (): void => {
            this.log.record('update-child-start-failed');
        });
        child.once('close', (code: number | null): void => {
            this.#closed = true;
            this.#ended.resolve(code ?? 1);
        });
        child.on('message', (message: unknown): void => {
            if (ConnectorUpdateMessage.read(message) === ConnectorUpdateStatus.Check) {
                this.#pending = true;
                this.#wake?.();
            }
        });
    }

    async #wait(delay: number, signal: AbortSignal): Promise<string> {
        const ready: PromiseWithResolvers<string> = Promise.withResolvers<string>();
        const timer: NodeJS.Timeout = setTimeout((): void => ready.resolve('check'), delay);
        const abort: () => void = (): void => ready.resolve('abort');
        const exited: () => void = (): void => ready.resolve('exit');
        const child: ChildProcess | null = this.#child;
        child?.once('close', exited);
        this.#wake = (): void => ready.resolve('check');
        signal.addEventListener('abort', abort, { once: true });
        try {
            if (this.#closed) {
                ready.resolve('exit');
            } else if (signal.aborted) {
                ready.resolve('abort');
            } else if (this.#pending) {
                ready.resolve('check');
            }
            this.#pending = false;
            return await ready.promise;
        } finally {
            clearTimeout(timer);
            signal.removeEventListener('abort', abort);
            child?.removeListener('close', exited);
            this.#wake = null;
        }
    }

    async #check(signal: AbortSignal): Promise<boolean> {
        const interrupted: AbortController = new AbortController();
        const stopped: () => void = (): void => interrupted.abort();
        const child: ChildProcess | null = this.#child;
        child?.once('close', stopped);
        const checking: AbortSignal = AbortSignal.any([signal, interrupted.signal]);
        try {
            this.#report(ConnectorUpdateStatus.Checking);
            const release: ConnectorUpdateRelease | null = await ConnectorUpdateDownload.check(
                this.settings,
                checking,
            );
            if (release === null) {
                this.#report(ConnectorUpdateStatus.Current);
                return false;
            }
            this.log.record('update-found', { version: release.version });
            await this.transaction.prepare(release, checking);
            checking.throwIfAborted();
            child?.removeListener('close', stopped);
            this.#report(ConnectorUpdateStatus.Installing);
            if (!(await this.#stopChild(15000))) {
                throw new Error(
                    'Connector did not stop cleanly; leaving the current version running',
                );
            }
            await this.transaction.install(release, signal);
            this.log.record('update-installed', { version: release.version });
            return true;
        } catch (caught: unknown) {
            this.log.record('update-check-failed', {
                reason: ConnectorConnectionLog.error(caught),
            });
            await this.transaction[Symbol.asyncDispose]();
            if (this.#closed && !signal.aborted && !interrupted.signal.aborted) {
                this.#start();
            }
            this.#report(ConnectorUpdateStatus.Failed);
            return false;
        } finally {
            child?.removeListener('close', stopped);
        }
    }

    #report(state: ConnectorUpdateStatus): void {
        if (this.#child?.connected) {
            const packet: ConnectorUpdatePacket = { nervaConnectorUpdate: state };
            this.#child.send(packet, (failure: Error | null): void => {
                if (failure !== null) {
                    this.log.record('update-status-channel-closed');
                }
            });
        }
    }

    async #stopChild(timeout: number): Promise<boolean> {
        if (this.#closed) {
            return true;
        }
        this.#child?.kill('SIGTERM');
        const ready: PromiseWithResolvers<boolean> = Promise.withResolvers<boolean>();
        const timer: NodeJS.Timeout = setTimeout((): void => ready.resolve(false), timeout);
        const child: ChildProcess | null = this.#child;
        const exited: () => void = (): void => ready.resolve(true);
        child?.once('close', exited);
        try {
            if (this.#closed) {
                ready.resolve(true);
            }
            return await ready.promise;
        } finally {
            clearTimeout(timer);
            child?.removeListener('close', exited);
        }
    }
}
