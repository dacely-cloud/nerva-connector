// SPDX-FileCopyrightText: 2026 Nerva contributors
// SPDX-License-Identifier: LicenseRef-Proprietary

import { execFile } from 'node:child_process';
import { stat } from 'node:fs/promises';
import { win32 } from 'node:path';
import { promisify } from 'node:util';

/** Build-time inputs owned by the caller; no customer runtime invokes this compiler. */
export interface WindowsCompilation {
    readonly sources: readonly string[];
    readonly entrypoint: string;
    readonly destination: string;
    /** `winexe` builds a windowed program with no console; the default is a console program. */
    readonly target?: 'exe' | 'winexe';
    /** A Win32 resource file carrying the icon, manifest and version information. */
    readonly win32Resource?: string;
    /** Files embedded as named managed resources. */
    readonly resources?: readonly WindowsEmbeddedResource[];
    /** Framework assemblies beyond the fixed set, by name without extension. */
    readonly references?: readonly string[];
}

/** One file embedded in a compiled program under a fixed resource name. */
export interface WindowsEmbeddedResource {
    readonly file: string;
    readonly name: string;
}

/** One compiler boundary for state and isolated qualification artifacts. */
export class ConnectorWindowsCompiler {
    /** Compiles C#5/.NET Framework with fixed references, warnings as errors and bounded compiler output/time. */
    public static async compile(input: WindowsCompilation): Promise<void> {
        const options: Parameters<typeof execFile.__promisify__>[2] = {
            timeout: 120000,
            maxBuffer: 16384,
            windowsHide: true,
        };
        if (process.platform !== 'win32') {
            await promisify(execFile)(
                'mcs',
                [
                    '-target:' + (input.target ?? 'exe'),
                    '-platform:anycpu',
                    '-optimize+',
                    '-debug-',
                    '-langversion:5',
                    '-warnaserror',
                    '-main:' + input.entrypoint,
                    '-r:System.Security',
                    '-r:System.Web.Extensions',
                    '-r:System.Drawing',
                    ...(input.references ?? []).map((name: string): string => '-r:' + name),
                    ...(input.win32Resource === undefined
                        ? []
                        : ['-win32res:' + input.win32Resource]),
                    ...(input.resources ?? []).map(
                        (resource: WindowsEmbeddedResource): string =>
                            '-resource:' + resource.file + ',' + resource.name,
                    ),
                    '-out:' + input.destination,
                    ...input.sources,
                ],
                options,
            );
            return;
        }
        const root: string | undefined = process.env['SystemRoot'];
        if (root === undefined || !/^[A-Za-z]:\\/u.test(root) || win32.resolve(root) !== root) {
            throw new Error('Windows SystemRoot is required to find the build-time C# compiler');
        }
        const paths: readonly string[] = [
            win32.join(root, 'Microsoft.NET/Framework64/v4.0.30319/csc.exe'),
            win32.join(root, 'Microsoft.NET/Framework/v4.0.30319/csc.exe'),
        ];
        let compiler: string | null = null;
        for (const path of paths) {
            try {
                if ((await stat(path)).isFile()) {
                    compiler = path;
                    break;
                }
            } catch (caught: unknown) {
                if (!(caught instanceof Error) || !('code' in caught) || caught.code !== 'ENOENT') {
                    throw caught;
                }
            }
        }
        if (compiler === null) {
            throw new Error('Windows build needs the .NET Framework 4.x C# compiler');
        }
        await promisify(execFile)(
            compiler,
            [
                '/nologo',
                '/target:' + (input.target ?? 'exe'),
                '/platform:anycpu',
                '/optimize+',
                '/debug-',
                '/warnaserror+',
                '/main:' + input.entrypoint,
                '/reference:System.dll',
                '/reference:System.Core.dll',
                '/reference:System.Security.dll',
                '/reference:System.Web.Extensions.dll',
                '/reference:System.Drawing.dll',
                ...(input.references ?? []).map(
                    (name: string): string => '/reference:' + name + '.dll',
                ),
                ...(input.win32Resource === undefined ? [] : ['/win32res:' + input.win32Resource]),
                ...(input.resources ?? []).map(
                    (resource: WindowsEmbeddedResource): string =>
                        '/resource:' + resource.file + ',' + resource.name,
                ),
                '/out:' + input.destination,
                ...input.sources,
            ],
            options,
        );
    }
}
