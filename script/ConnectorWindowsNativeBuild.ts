// SPDX-FileCopyrightText: 2026 Dacely <business@dacely.com>
// SPDX-License-Identifier: LicenseRef-Proprietary

import { createHash } from 'node:crypto';
import { open, readFile, rename, rm, type FileHandle } from 'node:fs/promises';
import { join } from 'node:path';
import type { WindowsStateArtifact } from '../src/windows/WindowsStateArtifact.ts';
import { WindowsStateBuild } from '../src/windows/WindowsStateBuild.ts';
import { WindowsStateArtifactFile } from '../src/windows/WindowsStateArtifactFile.ts';
import { ConnectorBuildArtifact } from './ConnectorBuildArtifact.ts';
import { ConnectorWindowsCompiler } from './ConnectorWindowsCompiler.ts';

/** Fixed build-time native entrypoint with optional generated digest constants. */
export interface WindowsNativeBuildInput {
    readonly directory: string;
    readonly stem: string;
    readonly entrypoint: string;
    readonly sources: readonly string[];
    readonly generatedSource?: string;
}

/** Publishes bounded compiled sidecars without retaining compilation intermediates. */
export class ConnectorWindowsNativeBuild {
    /** Cached output is accepted only after source and complete executable hash checks. */
    public static async build(input: WindowsNativeBuildInput): Promise<WindowsStateArtifact> {
        const sourceSha256: string = await this.#sourceSha256(input);
        const cached: WindowsStateArtifact | null = await this.#cached(input, sourceSha256);
        if (cached !== null) {
            return cached;
        }
        const executable: string = join(input.directory, input.stem + '.exe');
        const manifest: string = join(input.directory, input.stem + '.json');
        const temporary: string = executable + '.partial-' + process.pid.toString();
        const generated: string = temporary + '.cs';
        let owned: boolean = false;
        let generatedOwned: boolean = false;
        try {
            const reserved: FileHandle = await open(temporary, 'wx', 0o600);
            owned = true;
            await reserved.close();
            if (input.generatedSource !== undefined) {
                const source: FileHandle = await open(generated, 'wx', 0o600);
                generatedOwned = true;
                try {
                    await source.writeFile(input.generatedSource);
                } finally {
                    await source.close();
                }
            }
            await ConnectorWindowsCompiler.compile({
                sources: generatedOwned ? [...input.sources, generated] : input.sources,
                entrypoint: input.entrypoint,
                destination: temporary,
            });
            const bytes: Buffer = await readFile(temporary);
            if (
                bytes.byteLength < 512 ||
                bytes.byteLength > 262144 ||
                bytes[0] !== 0x4d ||
                bytes[1] !== 0x5a
            ) {
                throw new Error('Compiler did not produce a bounded Windows executable');
            }
            const artifact: WindowsStateArtifact = {
                bytes: bytes.byteLength,
                sha256: createHash('sha256').update(bytes).digest('hex'),
                sourceSha256,
            };
            const compiled: FileHandle = await open(temporary, 'r+');
            try {
                await compiled.sync();
            } finally {
                await compiled.close();
            }
            await rename(temporary, executable);
            await ConnectorBuildArtifact.publish(manifest, JSON.stringify(artifact) + '\n', 0o600);
            return artifact;
        } finally {
            try {
                if (generatedOwned) {
                    await rm(generated, { force: true });
                }
            } finally {
                if (owned) {
                    await rm(temporary, { force: true });
                }
            }
        }
    }

    /** Read-only cache verification cannot compile or repair output when a private publisher owns its directory. */
    public static async cached(
        input: WindowsNativeBuildInput,
    ): Promise<WindowsStateArtifact | null> {
        return await this.#cached(input, await this.#sourceSha256(input));
    }

    static async #sourceSha256(input: WindowsNativeBuildInput): Promise<string> {
        const parts: readonly string[] = await Promise.all(
            input.sources.map((source: string): Promise<string> => readFile(source, 'utf8')),
        );
        const text: string = [input.entrypoint, ...parts, input.generatedSource ?? '']
            .map((part: string): string => part.replaceAll('\r\n', '\n'))
            .join('\n');
        if (text.includes('\0') || text.includes('\r') || Buffer.byteLength(text) > 262144) {
            throw new Error('Invalid Windows helper source');
        }
        return createHash('sha256').update(text).digest('hex');
    }

    static async #cached(
        input: WindowsNativeBuildInput,
        sourceSha256: string,
    ): Promise<WindowsStateArtifact | null> {
        const executable: string = join(input.directory, input.stem + '.exe');
        const manifest: string = join(input.directory, input.stem + '.json');
        try {
            const cached: WindowsStateArtifact | null = await WindowsStateBuild.read(manifest);
            if (cached !== null && cached.sourceSha256 === sourceSha256) {
                await WindowsStateArtifactFile.verify(executable, cached);
                return cached;
            }
        } catch {
            /** Invalid cache is unavailable; only the explicit build caller may choose compilation. */
        }
        return null;
    }
}
