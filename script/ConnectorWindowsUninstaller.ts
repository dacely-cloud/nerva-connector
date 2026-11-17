// SPDX-FileCopyrightText: 2026 Nerva contributors
// SPDX-License-Identifier: LicenseRef-Proprietary

import { execFile } from 'node:child_process';
import { stat, writeFile } from 'node:fs/promises';
import { isAbsolute, join, resolve } from 'node:path';
import { promisify } from 'node:util';

/** Build-owned inputs for the standard NSIS uninstall engine. */
export interface WindowsUninstallerInput {
    readonly work: string;
    readonly destination: string;
    readonly version: string;
    readonly files: readonly string[];
}

/** Builds a native uninstaller without a runtime shell, script host or custom self-deletion command. */
export class ConnectorWindowsUninstaller {
    /** The caller owns and removes `work`, including the disposable compiler container and generated source. */
    public static async build(input: WindowsUninstallerInput): Promise<void> {
        if (!/^[0-9]+\.[0-9]+\.[0-9]+$/u.test(input.version)) {
            throw new Error('Uninstaller needs a plain major.minor.patch version');
        }
        if (input.files.length < 1 || input.files.length > 64) {
            throw new Error('Uninstaller requires between 1 and 64 installed program files');
        }
        const names: Set<string> = new Set();
        for (const name of input.files) {
            if (
                !/^[A-Za-z0-9 ._-]{1,128}$/u.test(name) ||
                name === '.' ||
                name === '..' ||
                names.has(name.toLowerCase())
            ) {
                throw new Error('Uninstaller requires distinct plain installed file names');
            }
            names.add(name.toLowerCase());
        }
        const files: string = join(input.work, 'uninstall-files.nsh');
        const source: string = join(input.work, 'uninstall.nsi');
        const finalizer: string = join(input.work, 'finalize-uninstaller.mjs');
        await writeFile(
            files,
            input.files.map((name: string): string => `Delete "$INSTDIR\\${name}"`).join('\n') +
                '\n',
        );
        await writeFile(
            finalizer,
            "import { copyFileSync } from 'node:fs';\n" +
                'copyFileSync(process.argv[2], process.argv[3]);\n',
        );
        const command: string = [process.execPath, finalizer, '%1', input.destination]
            .map((argument: string): string => this.#shellArgument(argument))
            .join(' ');
        await writeFile(
            source,
            [
                this.#define('CONTAINER', join(input.work, 'uninstall-container.exe')),
                this.#define('ICON', resolve('assets/windows/nerva-connector.ico')),
                this.#define('VERSION', input.version),
                this.#define('FILES', files),
                this.#define('FINALIZE', command),
                '!include ' + this.#quote(resolve('native/windows/installer/Uninstall.nsi')),
                '',
            ].join('\n'),
        );
        const compiler: string = await this.#compiler();
        const prefix: string = process.platform === 'win32' ? '/' : '-';
        await promisify(execFile)(compiler, [prefix + 'V2', prefix + 'WX', source], {
            timeout: 120000,
            maxBuffer: 16384,
        });
        if (!(await stat(input.destination)).isFile()) {
            throw new Error('NSIS did not produce the uninstaller');
        }
    }

    static #quote(value: string): string {
        if (/[\0\r\n]/u.test(value) || value.includes('${') || value.includes('$%')) {
            throw new Error('Invalid NSIS build value');
        }
        return '"' + value.replaceAll('"', '$\\"') + '"';
    }

    static #define(name: string, value: string): string {
        return '!define ' + name + ' ' + this.#quote(value);
    }

    static #shellArgument(value: string): string {
        if (process.platform === 'win32') {
            if (value !== '%1' && /[%!"\0\r\n]/u.test(value)) {
                throw new Error('Unsupported characters in Windows NSIS build path');
            }
            return '"' + value + '"';
        }
        return "'" + value.replaceAll("'", "'\"'\"'") + "'";
    }

    static async #compiler(): Promise<string> {
        const configured: string | undefined = process.env['NERVA_MAKENSIS'];
        if (configured !== undefined) {
            if (!isAbsolute(configured) || !(await stat(configured)).isFile()) {
                throw new Error('NERVA_MAKENSIS must name the installed NSIS compiler');
            }
            return configured;
        }
        if (process.platform === 'win32') {
            for (const variable of ['ProgramFiles(x86)', 'ProgramFiles']) {
                const directory: string | undefined = process.env[variable];
                if (directory !== undefined) {
                    const candidate: string = join(directory, 'NSIS', 'makensis.exe');
                    try {
                        if ((await stat(candidate)).isFile()) {
                            return candidate;
                        }
                    } catch (caught: unknown) {
                        if (
                            !(caught instanceof Error) ||
                            !('code' in caught) ||
                            caught.code !== 'ENOENT'
                        ) {
                            throw caught;
                        }
                    }
                }
            }
        }
        return 'makensis';
    }
}
