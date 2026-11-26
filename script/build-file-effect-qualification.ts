// SPDX-FileCopyrightText: 2026 Dacely <business@dacely.com>
// SPDX-License-Identifier: LicenseRef-Proprietary

import { isBuiltin } from 'node:module';
import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { rolldown, type RolldownBuild, type OutputChunk, type OutputAsset } from 'rolldown';
import { ConnectorBuildPaths } from './ConnectorBuildPaths.ts';

if (process.argv.length !== 2) {
    throw new Error('File-effect qualification builder accepts no arguments');
}
const packages: readonly string[] = [
    '@dacely/noble-post-quantum',
    '@noble/hashes',
    '@noble/curves',
];
const licenses: string[] = [];
for (const name of packages) {
    const license: string = await readFile(resolve('node_modules', name, 'LICENSE'), 'utf8');
    if (license.includes('*/')) {
        throw new Error('Unsupported embedded cryptographic license');
    }
    licenses.push('/** ' + name + ' license:\n' + license + '\n*/');
}
const bundle: RolldownBuild = await rolldown({
    input: resolve('test/support/FileEffectQualification.ts'),
    platform: 'node',
    external: (id: string): boolean => isBuiltin(id),
});
let code: string;
try {
    const output: Awaited<ReturnType<RolldownBuild['generate']>> = await bundle.generate({
        format: 'esm',
        codeSplitting: false,
        sourcemap: false,
        minify: true,
    });
    const chunk: OutputChunk | OutputAsset | undefined = output.output[0];
    if (
        output.output.length !== 1 ||
        chunk === undefined ||
        chunk.type !== 'chunk' ||
        chunk.dynamicImports.length !== 0 ||
        !chunk.imports.every((id: string): boolean => isBuiltin(id))
    ) {
        throw new Error('Qualification must be one self-contained Node module');
    }
    for (const id of Object.keys(chunk.modules)) {
        if (
            !id.startsWith('\0') &&
            !ConnectorBuildPaths.contains(resolve('src'), id) &&
            !ConnectorBuildPaths.contains(resolve('test/support'), id) &&
            !packages.some((name: string): boolean =>
                ConnectorBuildPaths.contains(resolve('node_modules', name), id),
            )
        ) {
            throw new Error('Unexpected qualification module');
        }
    }
    code = licenses.join('\n') + '\n' + chunk.code;
    if (Buffer.byteLength(code) > 524288) {
        throw new Error('Qualification exceeds 512 KiB');
    }
} finally {
    await bundle.close();
}
const written: PromiseWithResolvers<undefined> = Promise.withResolvers<undefined>();
process.stdout.write(code, (caught?: Error | null): void => {
    if (caught === undefined || caught === null) {
        written.resolve(undefined);
    } else {
        written.reject(caught);
    }
});
await written.promise;
