// SPDX-FileCopyrightText: 2026 Nerva contributors
// SPDX-License-Identifier: LicenseRef-Proprietary

import { isBuiltin } from 'node:module';
import { resolve } from 'node:path';
import { rolldown, type RolldownBuild, type OutputChunk, type OutputAsset } from 'rolldown';
import { ConnectorBuildArtifact } from './ConnectorBuildArtifact.ts';

/** One stable process-owner worker is part of the intentional connector application assets. */
export class ConnectorHostWorkerBuild {
    /** Bundle only local runtime code and builtin imports, pruning no outputs belonging to other tasks. */
    public static async build(destination: string): Promise<void> {
        const bundle: RolldownBuild = await rolldown({
            input: resolve('src/host/HostProcessWorker.ts'),
            platform: 'node',
            external: (id: string): boolean => isBuiltin(id),
        });
        try {
            const result: Awaited<ReturnType<RolldownBuild['generate']>> = await bundle.generate({
                format: 'esm',
                codeSplitting: false,
                minify: true,
                sourcemap: false,
            });
            const chunk: OutputChunk | OutputAsset | undefined = result.output[0];
            if (
                result.output.length !== 1 ||
                chunk?.type !== 'chunk' ||
                chunk.dynamicImports.length !== 0 ||
                !chunk.imports.every((id: string): boolean => isBuiltin(id)) ||
                Buffer.byteLength(chunk.code) > 262144
            ) {
                throw new Error('Invalid host process worker artifact');
            }
            await ConnectorBuildArtifact.publish(destination, chunk.code, 0o700);
        } finally {
            await bundle.close();
        }
    }
}
