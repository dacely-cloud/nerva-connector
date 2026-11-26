// SPDX-FileCopyrightText: 2026 Dacely <business@dacely.com>
// SPDX-License-Identifier: LicenseRef-Proprietary

import { execFile } from 'node:child_process';
import { lstat, mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { ConnectorUpdatePaths } from './ConnectorUpdatePaths.js';
import {
    ConnectorUpdatePlatform,
    type ConnectorUpdateSettings,
} from './ConnectorUpdateProtocol.js';

/** Offline staging preserves the complete Mac code signature and never modifies the running program. */
export class ConnectorUpdatePackage {
    /** The application root and its runtime directory have a fixed relationship on each native platform. */
    public static program(root: string, platform: ConnectorUpdatePlatform): string {
        return platform === ConnectorUpdatePlatform.Mac
            ? join(root, 'Contents/Resources/app')
            : root;
    }

    /** Inherited Node injection and TLS overrides cannot influence installed runtime checks or restarts. */
    public static environment(): Record<string, string> {
        const environment: Record<string, string> = {};
        for (const [name, value] of Object.entries(process.env)) {
            if (value !== undefined) {
                environment[name] = value;
            }
        }
        environment['NODE_OPTIONS'] = '';
        environment['NODE_PATH'] = '';
        environment['NODE_EXTRA_CA_CERTS'] = '';
        environment['NODE_TLS_REJECT_UNAUTHORIZED'] = '1';
        return environment;
    }

    /** Verified Linux setup runs offline; Mac disk images are mounted read-only and always detached. */
    public static async stage(
        installer: string,
        work: string,
        settings: ConnectorUpdateSettings,
        signal: AbortSignal,
    ): Promise<string> {
        const next: string = join(
            work,
            settings.platform === ConnectorUpdatePlatform.Mac ? 'Nerva Connector.app' : 'next',
        );
        if (settings.platform === ConnectorUpdatePlatform.Linux) {
            await promisify(execFile)(
                '/bin/sh',
                [installer, '--destination', next, '--no-shortcuts'],
                { timeout: 180000, maxBuffer: 65536, signal, env: this.environment() },
            );
        } else {
            const image: string = join(work, 'image');
            await mkdir(image, { mode: 0o700 });
            try {
                await promisify(execFile)(
                    '/usr/bin/hdiutil',
                    ['attach', '-quiet', '-readonly', '-nobrowse', '-mountpoint', image, installer],
                    { timeout: 60000, maxBuffer: 65536, signal, env: this.environment() },
                );
                const source: string = join(image, 'Nerva Connector.app');
                if (!(await lstat(source)).isDirectory()) {
                    throw new Error('Mac update has no regular application bundle');
                }
                await ConnectorUpdatePaths.tree(source, false);
                await promisify(execFile)('/usr/bin/ditto', [source, next], {
                    timeout: 60000,
                    maxBuffer: 65536,
                    signal,
                    env: this.environment(),
                });
            } finally {
                await this.detach(work);
            }
            await this.macSignature(next, signal);
        }
        await ConnectorUpdatePaths.tree(next);
        return next;
    }

    /** A complete signed bundle is verified again at its actual destination after the swap. */
    public static async macSignature(root: string, signal: AbortSignal): Promise<void> {
        await promisify(execFile)('/usr/bin/codesign', ['--verify', '--deep', '--strict', root], {
            timeout: 60000,
            maxBuffer: 65536,
            signal,
            env: this.environment(),
        });
    }

    /** The bundled runtime and supervisor must report exactly the signed target version before they can replace an installation. */
    public static async smoke(
        root: string,
        settings: ConnectorUpdateSettings,
        version: string,
        signal: AbortSignal,
    ): Promise<void> {
        const program: string = this.program(root, settings.platform);
        const runtime: string = join(program, 'node');
        const result: Awaited<ReturnType<typeof execFile.__promisify__>> = await promisify(
            execFile,
        )(runtime, [join(program, 'nerva-connector-update.mjs'), '--version'], {
            timeout: 10000,
            maxBuffer: 1024,
            signal,
            env: this.environment(),
        });
        if (result.stdout.toString().trim() !== version) {
            throw new Error('Update program differs from its signed version');
        }
        await promisify(execFile)(
            runtime,
            [join(program, 'nerva-connector.mjs'), 'connector', '--help'],
            { timeout: 10000, maxBuffer: 65536, signal, env: this.environment() },
        );
    }

    /** Recovery detaches only an image mounted inside this updater's marked private work directory. */
    public static async detach(work: string): Promise<void> {
        const image: string = join(work, 'image');
        if (!(await ConnectorUpdatePaths.exists(image))) {
            return;
        }
        const [mounted, parent]: readonly [
            Awaited<ReturnType<typeof lstat>>,
            Awaited<ReturnType<typeof lstat>>,
        ] = await Promise.all([lstat(image), lstat(work)]);
        if (mounted.dev !== parent.dev) {
            await promisify(execFile)('/usr/bin/hdiutil', ['detach', '-quiet', image], {
                timeout: 30000,
                maxBuffer: 65536,
                env: this.environment(),
            });
        }
    }
}
