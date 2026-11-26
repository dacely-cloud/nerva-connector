// SPDX-FileCopyrightText: 2026 Dacely <business@dacely.com>
// SPDX-License-Identifier: LicenseRef-Proprietary

import { isBuiltin } from 'node:module';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { resolve } from 'node:path';
import {
    rolldown,
    type RolldownBuild,
    type OutputChunk,
    type OutputAsset,
    type Plugin,
} from 'rolldown';
import { transform, type TransformResult } from 'rolldown/utils';

/** The existing publisher-only compiler retains audited source origins without adding another loader or output tree. */
export class ConnectorReleaseLauncher {
    /** Only the native state metadata module needs its source-relative build paths after data-URL evaluation. */
    public static originPlugin(): Plugin {
        const source: string = fileURLToPath(
            new URL('../src/windows/WindowsStateBuild.ts', import.meta.url),
        );
        return {
            name: 'connector-release-state-source-origin',
            async transform(code: string, id: string): Promise<string | null> {
                if (resolve(id) !== source) {
                    return null;
                }
                const transformed: TransformResult = await transform(id, code, {
                    lang: 'ts',
                    define: { 'import.meta.url': JSON.stringify(pathToFileURL(source).href) },
                });
                if (transformed.errors.length !== 0 || transformed.warnings.length !== 0) {
                    throw new Error('Invalid release state-source origin transform');
                }
                return transformed.code;
            },
        };
    }

    /** One in-memory module runs preparation; errors remain finite and no failed bundle or dependency cache is published. */
    public static async main(): Promise<void> {
        let build: RolldownBuild | null = null;
        try {
            build = await rolldown({
                input: fileURLToPath(new URL('./PrepareRelease.ts', import.meta.url)),
                platform: 'node',
                external: (id: string): boolean => isBuiltin(id),
                plugins: [this.originPlugin()],
            });
            const result: Awaited<ReturnType<RolldownBuild['generate']>> = await build.generate({
                format: 'esm',
                codeSplitting: false,
                sourcemap: false,
            });
            const entry: OutputChunk | OutputAsset | undefined = result.output[0];
            if (
                result.output.length !== 1 ||
                entry === undefined ||
                entry.type !== 'chunk' ||
                entry.dynamicImports.length !== 0 ||
                !entry.imports.every((id: string): boolean => isBuiltin(id))
            ) {
                throw new Error(
                    'Release preparation requires one in-memory controller-only module',
                );
            }
            await import(
                'data:text/javascript;base64,' + Buffer.from(entry.code).toString('base64')
            );
        } catch {
            process.stderr.write(
                'Connector release preparation failed; validate the protected configuration, runtime and signing authority\n',
            );
            process.exitCode = 1;
        } finally {
            await build?.close();
        }
    }
}

if (process.argv[1] !== undefined && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
    await ConnectorReleaseLauncher.main();
}
