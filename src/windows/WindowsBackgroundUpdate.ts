// SPDX-FileCopyrightText: 2026 Dacely <business@dacely.com>
// SPDX-License-Identifier: LicenseRef-Proprietary

import { existsSync } from 'node:fs';
import { HostDesktopCommand } from '../host/HostDesktopCommand.js';
import { HostWindowsBuild } from '../host/HostWindowsBuild.js';
import { ConnectorUpdateStatus } from '../update/ConnectorUpdateMessage.js';
import { WindowsBackgroundStartup } from './WindowsBackgroundStartup.js';

/** The installed Windows supervisor retains signed release authority; the console can only request its check. */
export class WindowsBackgroundUpdate {
    static readonly #prefix: string = 'Local\\NervaConnector.Update.';
    /** Allows the native helper to finish its 750-second wait before it is terminated. */
    static readonly #replyTimeoutMs: number = 755000;
    readonly #event: string;
    private constructor(event: string) {
        this.#event = event;
    }

    /** Only the configured installed supervisor injects this bounded, per-instance update event token. */
    public static find(
        platform: NodeJS.Platform = process.platform,
        environment: NodeJS.ProcessEnv = process.env,
        exists: (path: string) => boolean = existsSync,
    ): WindowsBackgroundUpdate | null {
        const event: string | undefined = environment['NERVA_CONNECTOR_UPDATE_EVENT'];
        if (
            event === undefined ||
            event.length !== this.#prefix.length + 32 ||
            !/^Local\\NervaConnector\.Update\.[a-f0-9]{32}$/u.test(event) ||
            WindowsBackgroundStartup.find(platform, environment, exists) === null
        ) {
            return null;
        }
        return new WindowsBackgroundUpdate(event);
    }

    /** Requests a check through the pinned helper and accepts only its finite supervisor result. */
    public async check(signal: AbortSignal): Promise<ConnectorUpdateStatus> {
        signal.throwIfAborted();
        const helper: string = await HostWindowsBuild.verifiedExecutable();
        signal.throwIfAborted();
        const result: Buffer = await HostDesktopCommand.run(
            helper,
            ['--connector-update', this.#event],
            process.env,
            4096,
            undefined,
            { signal, timeoutMs: WindowsBackgroundUpdate.#replyTimeoutMs },
        );
        const status: string = result.toString('utf8').trim();
        switch (status) {
            case ConnectorUpdateStatus.Current:
            case ConnectorUpdateStatus.Installing:
            case ConnectorUpdateStatus.Failed:
                return status;
            default:
                throw new Error('The Windows updater returned an unknown status');
        }
    }
}
