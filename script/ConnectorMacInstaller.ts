// SPDX-FileCopyrightText: 2026 Nerva contributors
// SPDX-License-Identifier: LicenseRef-Proprietary

import { execFile } from 'node:child_process';
import { mkdir, readFile, rm, symlink } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { promisify } from 'node:util';
import { ConnectorBuildArtifact } from './ConnectorBuildArtifact.ts';

/** Native macOS tools build an application that opens the connector's console in Terminal, inside a drag-to-install disk image. */
export class ConnectorMacInstaller {
    /** Creates the application shell before the caller stages its bundled runtime and pinned native helper. */
    public static async application(
        work: string,
        version: string,
        signal: AbortSignal,
    ): Promise<string> {
        if (process.platform !== 'darwin') {
            throw new Error('macOS installers must be built and checked on macOS');
        }
        const image: string = join(work, 'image');
        const application: string = join(image, 'Nerva Connector.app');
        await mkdir(image, { recursive: true, mode: 0o700 });
        const script: string = join(work, 'Launcher.applescript');
        await ConnectorBuildArtifact.publish(
            script,
            [
                'on run',
                '    set resources to POSIX path of (path to resource "app")',
                '    set command to quoted form of (resources & "/nerva-connector")',
                '    tell application "Terminal"',
                '        activate',
                '        do script command',
                '    end tell',
                'end run',
                '',
            ].join('\n'),
            0o600,
        );
        await this.#run('/usr/bin/osacompile', ['-o', application, script], signal);
        const plist: string = join(application, 'Contents/Info.plist');
        for (const [key, value] of [
            ['CFBundleName', 'Nerva Connector'],
            ['CFBundleIdentifier', 'com.nervalabs.connector'],
            ['CFBundleShortVersionString', version],
            ['CFBundleVersion', version],
            [
                'NSAppleEventsUsageDescription',
                'Nerva Connector opens its connection and permission console in Terminal.',
            ],
        ] as const) {
            await this.#run('/usr/bin/plutil', ['-replace', key, '-string', value, plist], signal);
        }
        const iconset: string = join(work, 'Nerva.iconset');
        await mkdir(iconset, { mode: 0o700 });
        for (const size of [16, 32, 128, 256, 512]) {
            for (const scale of [1, 2]) {
                await this.#run(
                    '/usr/bin/sips',
                    [
                        '-z',
                        (size * scale).toString(),
                        (size * scale).toString(),
                        resolve('assets/windows/nerva-connector-logo.png'),
                        '--out',
                        join(
                            iconset,
                            `icon_${size.toString()}x${size.toString()}${scale === 2 ? '@2x' : ''}.png`,
                        ),
                    ],
                    signal,
                );
            }
        }
        await this.#run(
            '/usr/bin/iconutil',
            ['-c', 'icns', iconset, '-o', join(application, 'Contents/Resources/applet.icns')],
            signal,
        );
        await symlink('/Applications', join(image, 'Applications'));
        const payload: string = join(application, 'Contents/Resources/app');
        await mkdir(payload, { mode: 0o700 });
        return payload;
    }

    /** Ad-hoc signing checks local bundle integrity; Developer ID signing and notarization remain a publisher step. */
    public static async build(
        work: string,
        destination: string,
        signal: AbortSignal,
    ): Promise<void> {
        const image: string = join(work, 'image');
        const application: string = join(image, 'Nerva Connector.app');
        await this.#run('/usr/bin/codesign', ['--force', '--sign', '-', application], signal);
        await this.#run(
            '/usr/bin/codesign',
            ['--verify', '--deep', '--strict', application],
            signal,
        );
        const partial: string = join(work, 'Nerva-Connector.dmg');
        try {
            await this.#run(
                '/usr/bin/hdiutil',
                [
                    'create',
                    '-quiet',
                    '-format',
                    'UDZO',
                    '-volname',
                    'Nerva Connector',
                    '-srcfolder',
                    image,
                    partial,
                ],
                signal,
            );
            await this.#run('/usr/bin/hdiutil', ['verify', '-quiet', partial], signal);
            signal.throwIfAborted();
            await ConnectorBuildArtifact.publish(destination, await readFile(partial), 0o600);
        } finally {
            await rm(partial, { force: true });
        }
    }

    static async #run(
        command: string,
        arguments_: readonly string[],
        signal: AbortSignal,
    ): Promise<void> {
        await promisify(execFile)(command, [...arguments_], {
            timeout: 180000,
            maxBuffer: 65536,
            signal,
        });
    }
}
