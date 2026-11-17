// SPDX-FileCopyrightText: 2026 Nerva contributors
// SPDX-License-Identifier: LicenseRef-Proprietary

import { existsSync } from 'node:fs';
import { HostDesktopCommand } from '../host/HostDesktopCommand.js';
import { HostWindowsBuild } from '../host/HostWindowsBuild.js';
import { WindowsBackgroundStartup } from './WindowsBackgroundStartup.js';

/** The installed Windows supervisor retains signed release authority; the console can only request its check. */
export class WindowsBackgroundUpdate {
    static readonly #prefix: string = 'Local\\NervaConnector.Update.';
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

    /** Cancellation prevents admission; after the fixed event is submitted, the supervisor owns the asynchronous check. */
    public async check(signal: AbortSignal): Promise<void> {
        signal.throwIfAborted();
        const helper: string = await HostWindowsBuild.verifiedExecutable();
        signal.throwIfAborted();
        try {
            await HostDesktopCommand.run(
                helper,
                ['--connector-update', this.#event],
                process.env,
                4096,
            );
        } catch {
            throw new Error(
                'Could not reach the installed Windows updater. Reopen Nerva Connector and try /update again.',
            );
        }
    }
}
