// SPDX-FileCopyrightText: 2026 Dacely <business@dacely.com>
// SPDX-License-Identifier: LicenseRef-Proprietary

import { execFile } from 'node:child_process';
import { existsSync } from 'node:fs';
import { win32 } from 'node:path';

/**
 * Whether the installed Windows connector starts in the background when the user signs in.
 *
 * @remarks
 * Only the installed "Nerva Connector.exe" knows this setting, a value under the user's Run key, so the connector
 * asks it: `--startup status` exits 10 when on and 11 when off, and `--startup on` or `off` exits 0 once changed. That
 * program passes its own path in NERVA_CONNECTOR_SUPERVISOR when it starts the connector; a connector started any
 * other way, such as from a source checkout, has no such setting and {@link WindowsBackgroundStartup.find} returns
 * `null`.
 */
export class WindowsBackgroundStartup {
    static readonly #name: string = 'Nerva Connector.exe';

    private constructor(public readonly program: string) {}

    /** The installed program's setting, or `null` when this connector was not started by it. */
    public static find(
        platform: NodeJS.Platform = process.platform,
        environment: NodeJS.ProcessEnv = process.env,
        exists: (path: string) => boolean = existsSync,
    ): WindowsBackgroundStartup | null {
        const program: string | undefined = environment['NERVA_CONNECTOR_SUPERVISOR'];
        if (
            platform !== 'win32' ||
            program === undefined ||
            !win32.isAbsolute(program) ||
            win32.basename(win32.normalize(program)) !== this.#name ||
            !exists(program)
        ) {
            return null;
        }
        return new WindowsBackgroundStartup(program);
    }

    /** Whether the connector starts in the background at sign-in. */
    public async enabled(signal: AbortSignal): Promise<boolean> {
        const code: number = await this.#run('status', signal);
        if (code !== 10 && code !== 11) {
            throw new Error('Nerva Connector could not read the sign-in setting');
        }
        return code === 10;
    }

    /** Turns starting in the background at sign-in on or off. */
    public async set(enabled: boolean, signal: AbortSignal): Promise<void> {
        if ((await this.#run(enabled ? 'on' : 'off', signal)) !== 0) {
            throw new Error('Nerva Connector could not change the sign-in setting');
        }
    }

    async #run(argument: string, signal: AbortSignal): Promise<number> {
        const result: PromiseWithResolvers<number> = Promise.withResolvers<number>();
        execFile(
            this.program,
            ['--startup', argument],
            { signal, timeout: 10000, windowsHide: true },
            (error: Error | null): void => {
                if (error === null) {
                    result.resolve(0);
                    return;
                }
                const code: unknown = Reflect.get(error, 'code');
                if (typeof code === 'number') {
                    result.resolve(code);
                } else {
                    result.reject(error);
                }
            },
        );
        return await result.promise;
    }
}
