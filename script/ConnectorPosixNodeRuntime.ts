// SPDX-FileCopyrightText: 2026 Dacely <business@dacely.com>
// SPDX-License-Identifier: LicenseRef-Proprietary

import { execFile } from 'node:child_process';
import { createHash, type Hash } from 'node:crypto';
import { mkdir, open, readdir, rename, rm, type FileHandle } from 'node:fs/promises';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { ConnectorBuildArtifact } from './ConnectorBuildArtifact.ts';
import type {
    ConnectorPosixArchitecture,
    ConnectorPosixPlatform,
} from './ConnectorPosixPlatform.ts';

/** The runtime and license extracted from one checksum-pinned official Node archive. */
export interface ConnectorPosixNodeFiles {
    readonly node: string;
    readonly license: string;
}

/** Downloads a finite official runtime archive and extracts only Node and its license, never npm or dependencies. */
export class ConnectorPosixNodeRuntime {
    /** Kept at the same reviewed release as the Windows setup runtime. */
    public static readonly version: string = '26.12.1';
    static readonly #maximumBytes: number = 268435456;
    static readonly #digests: Readonly<
        Record<ConnectorPosixPlatform, Readonly<Record<ConnectorPosixArchitecture, string>>>
    > = {
        linux: {
            x64: '0fd1eb7770598f52a21995edf6ed35fc690400fa437c2386af329519e9143132',
            arm64: 'a6c01af459dd8972ab3fb08ee5da81244d26ba8c4944a62d5bbba8c597ae154f',
        },
        darwin: {
            x64: 'b85c2ea4420ad0bc4abf2dc6cf1f55130ed681f1cabf60cf3f526e4c9e2712ff',
            arm64: '1901d539912c02afa10d1cc126943a8855a7eedebe830119463470db5e6c59e8',
        },
    };

    /** Reuses the current archive and removes obsolete versions only within this builder's own cache. */
    public static async obtain(
        cache: string,
        destination: string,
        platform: ConnectorPosixPlatform,
        architecture: ConnectorPosixArchitecture,
        signal: AbortSignal,
    ): Promise<ConnectorPosixNodeFiles> {
        await mkdir(cache, { recursive: true, mode: 0o700 });
        const prefix: string = `node-v${this.version}-${platform}-${architecture}`;
        const archive: string = join(cache, prefix + '.tar.gz');
        for (const name of await readdir(cache)) {
            if (
                /^node-v[0-9.]+-(linux|darwin)-(x64|arm64)\.tar\.gz$/u.test(name) &&
                !name.startsWith(`node-v${this.version}-`)
            ) {
                await rm(join(cache, name));
            }
        }
        const digest: string = this.#digests[platform][architecture];
        let cached: boolean;
        try {
            cached = (await this.#digest(archive, signal)) === digest;
        } catch (caught: unknown) {
            if (!(caught instanceof Error) || !('code' in caught) || caught.code !== 'ENOENT') {
                throw caught;
            }
            cached = false;
        }
        if (!cached) {
            await this.#download(archive, prefix, digest, signal);
        }
        const files: ConnectorPosixNodeFiles = {
            node: join(destination, 'node'),
            license: join(destination, 'NODE-LICENSE.txt'),
        };
        for (const [member, output] of [
            ['bin/node', files.node],
            ['LICENSE', files.license],
        ] as const) {
            const result: Awaited<ReturnType<typeof execFile.__promisify__>> = await promisify(
                execFile,
            )('tar', ['-xzOf', archive, prefix + '/' + member], {
                encoding: 'buffer',
                maxBuffer: this.#maximumBytes,
                timeout: 60000,
                signal,
            });
            await ConnectorBuildArtifact.publish(
                output,
                result.stdout,
                member === 'bin/node' ? 0o700 : 0o600,
            );
        }
        return files;
    }

    static async #digest(path: string, signal: AbortSignal): Promise<string> {
        const hash: Hash = createHash('sha256');
        let bytes: bigint = 0n;
        const file: FileHandle = await open(path, 'r');
        try {
            const buffer: Buffer = Buffer.alloc(65536);
            while (true) {
                signal.throwIfAborted();
                const result: Awaited<ReturnType<FileHandle['read']>> = await file.read(
                    buffer,
                    0,
                    buffer.byteLength,
                    null,
                );
                if (result.bytesRead === 0) {
                    break;
                }
                bytes += BigInt(result.bytesRead);
                if (bytes > BigInt(this.#maximumBytes)) {
                    throw new Error('Node archive exceeds the download limit');
                }
                hash.update(buffer.subarray(0, result.bytesRead));
            }
        } finally {
            await file.close();
        }
        return hash.digest('hex');
    }

    static async #download(
        archive: string,
        prefix: string,
        digest: string,
        signal: AbortSignal,
    ): Promise<void> {
        const partial: string = archive + '.partial-' + process.pid.toString();
        let owned: boolean = false;
        try {
            const response: Response = await fetch(
                `https://nodejs.org/dist/v${this.version}/${prefix}.tar.gz`,
                {
                    redirect: 'error',
                    signal: AbortSignal.any([signal, AbortSignal.timeout(300000)]),
                },
            );
            if (!response.ok || response.body === null) {
                await response.body?.cancel();
                throw new Error(`Node runtime download failed: HTTP ${response.status.toString()}`);
            }
            const file: FileHandle = await open(partial, 'wx', 0o600);
            owned = true;
            try {
                const hash: Hash = createHash('sha256');
                let bytes: bigint = 0n;
                for await (const chunk of response.body) {
                    bytes += BigInt(chunk.byteLength);
                    if (bytes > BigInt(this.#maximumBytes)) {
                        throw new Error('Node runtime download exceeds the byte limit');
                    }
                    hash.update(chunk);
                    await file.writeFile(chunk);
                }
                if (hash.digest('hex') !== digest) {
                    throw new Error('Node runtime does not match its pinned SHA-256');
                }
                await file.sync();
            } finally {
                await file.close();
            }
            signal.throwIfAborted();
            await rename(partial, archive);
        } finally {
            if (owned) {
                await rm(partial, { force: true });
            }
        }
    }
}
