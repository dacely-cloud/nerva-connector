// SPDX-FileCopyrightText: 2026 Nerva contributors
// SPDX-License-Identifier: LicenseRef-Proprietary

import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { resolve } from 'node:path';
import { isBuiltin } from 'node:module';
import { expect, it } from 'vitest';
import {
    rolldown,
    type RolldownBuild,
    type Plugin,
    type OutputChunk,
    type OutputAsset,
} from 'rolldown';
import { ConnectorReleaseLauncher } from '../script/prepare-release.js';

it('in-memory release preparation resolves the actual Windows state helper source origin without rewriting literal payloads', async (): Promise<void> => {
    const source: string = fileURLToPath(
        new URL('../src/windows/WindowsStateBuild.ts', import.meta.url),
    );
    const fixture: string = '\0release-origin-fixture';
    const input: Plugin = {
        name: 'isolated-release-origin-entry',
        resolveId(id: string): string | null {
            return id === fixture ? fixture : null;
        },
        async load(id: string): Promise<string | null> {
            if (id === fixture) {
                return (
                    'import {WindowsStateBuild,originLiteral} from ' +
                    JSON.stringify(source) +
                    ';export const executable=WindowsStateBuild.executable();export const literal=originLiteral;export const untouched="import.meta.url";'
                );
            }
            if (resolve(id) === source) {
                return (
                    (await readFile(source, 'utf8')) +
                    '\nexport const originLiteral="import.meta.url";\n'
                );
            }
            return null;
        },
    };
    const build: RolldownBuild = await rolldown({
        input: fixture,
        platform: 'node',
        external: (id: string): boolean => isBuiltin(id),
        plugins: [input, ConnectorReleaseLauncher.originPlugin()],
    });
    try {
        const result: Awaited<ReturnType<RolldownBuild['generate']>> = await build.generate({
            format: 'esm',
            codeSplitting: false,
            sourcemap: false,
        });
        const entry: OutputChunk | OutputAsset | undefined = result.output[0];
        if (result.output.length !== 1 || entry?.type !== 'chunk') {
            throw new Error('Invalid isolated in-memory origin fixture');
        }
        const loaded: unknown = await import(
            'data:text/javascript;base64,' + Buffer.from(entry.code).toString('base64')
        );
        expect(loaded).toMatchObject({
            executable: fileURLToPath(
                new URL('../build/nerva-connector-state.exe', import.meta.url),
            ),
            literal: 'import.meta.url',
            untouched: 'import.meta.url',
        });
    } finally {
        await build.close();
    }
});
