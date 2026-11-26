// SPDX-FileCopyrightText: 2026 Dacely <business@dacely.com>
// SPDX-License-Identifier: LicenseRef-Proprietary

import { lstat } from 'node:fs/promises';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { ProtectedFiles } from '../local/ProtectedFiles.js';

/** Automatic native host preparation is explicitly root-owned and qualified for the approved Ubuntu Server family. */
export class ConnectorNativeDependencies {
    /** Existing tools are verified first; only missing fixed dependencies invoke Ubuntu's authenticated package manager. */
    public static async ensure(signal: AbortSignal): Promise<void> {
        await this.#supported();
        let missing: boolean = false;
        for (const path of ['/usr/bin/bwrap', '/usr/sbin/apparmor_parser']) {
            try {
                await this.#trusted(path);
            } catch (caught: unknown) {
                if (!(caught instanceof Error) || !('code' in caught) || caught.code !== 'ENOENT') {
                    throw caught;
                }
                missing = true;
            }
        }
        if (!missing) {
            await ProtectedFiles.directory('/sys/kernel/security/apparmor');
            return;
        }
        await this.#install(signal);
        await this.verify();
    }
    /** Repeating a completed installation is read-only even when its native service is active. */
    public static async verify(): Promise<void> {
        await this.#supported();
        for (const path of ['/usr/bin/bwrap', '/usr/sbin/apparmor_parser']) {
            await this.#trusted(path);
        }
        await ProtectedFiles.directory('/sys/kernel/security/apparmor');
    }
    static async #supported(): Promise<void> {
        if (process.platform !== 'linux' || process.getuid?.() !== 0) {
            throw new Error('Native host setup requires an explicit root invocation');
        }
        const release: string = new TextDecoder('utf-8', { fatal: true }).decode(
            await ProtectedFiles.readTrusted('/usr/lib/os-release', 8192, false),
        );
        if (!/^ID=ubuntu$/mu.test(release) || !/^VERSION_ID="?26\.04"?$/mu.test(release)) {
            throw new Error('Approved Ubuntu Server 26.04 host required');
        }
    }
    static async #install(signal: AbortSignal): Promise<void> {
        await this.#trusted('/usr/bin/apt-get');
        for (const args of [
            ['update'],
            [
                '-y',
                '--no-install-recommends',
                '-o',
                'Dpkg::Options::=--force-confold',
                'install',
                'bubblewrap',
                'apparmor',
            ],
        ]) {
            try {
                await promisify(execFile)('/usr/bin/apt-get', args, {
                    env: {
                        PATH: '/usr/bin:/bin',
                        LANG: 'C',
                        LC_ALL: 'C',
                        DEBIAN_FRONTEND: 'noninteractive',
                        APT_LISTCHANGES_FRONTEND: 'none',
                        NEEDRESTART_MODE: 'l',
                    },
                    timeout: 180000,
                    maxBuffer: 65536,
                    signal,
                });
            } catch {
                signal.throwIfAborted();
                throw new Error('Approved Ubuntu native dependency installation failed');
            }
        }
    }
    static async #trusted(path: string): Promise<void> {
        await ProtectedFiles.directory(path.slice(0, path.lastIndexOf('/')));
        const state: Awaited<ReturnType<typeof lstat>> = await lstat(path);
        if (
            !state.isFile() ||
            state.uid !== 0 ||
            (state.mode & 0o6022) !== 0 ||
            (state.mode & 0o100) === 0
        ) {
            throw new Error('Trusted fixed native host tool required');
        }
    }
}
