// SPDX-FileCopyrightText: 2026 Nerva contributors
// SPDX-License-Identifier: LicenseRef-Proprietary

import type { BigIntStats } from 'node:fs';
import { open, link, rename, rm, lstat, type FileHandle } from 'node:fs/promises';
import { join } from 'node:path';
import { ProtectedArtifact } from '../local/ProtectedArtifact.js';
import type { ConnectorPrivateDirectory } from '../runtime/ConnectorPrivateDirectory.js';
import { ConnectorReleaseFile, type ConnectorReleaseArtifact } from './ConnectorRelease.js';
import { ConnectorReleaseCodec } from './ConnectorReleaseCodec.js';
import { WindowsStateOwner } from '../windows/WindowsStateOwner.js';
import { WindowsStateOperation } from '../windows/WindowsStateProtocol.js';

/** Bounded descriptor-based copy verifies all bytes again before publishing an executable. */
export class ConnectorReleaseArtifacts {
    /** The offline signer uses the same protected bounded reader as the installer. */
    public static async describe(
        path: string,
        name: ConnectorReleaseFile,
        signal: AbortSignal,
    ): Promise<ConnectorReleaseArtifact> {
        if (process.platform === 'win32') {
            signal.throwIfAborted();
            const metadata: ReturnType<typeof WindowsStateOwner.artifact> =
                WindowsStateOwner.artifact(
                    await WindowsStateOwner.request(WindowsStateOperation.ArtifactDescribe, {
                        path,
                        maximumBytes: ConnectorReleaseCodec.maximum(name),
                    }),
                    ConnectorReleaseCodec.maximum(name),
                );
            signal.throwIfAborted();
            return { name, ...metadata };
        }
        const status: BigIntStats = await lstat(path, { bigint: true });
        ProtectedArtifact.trusted(status, ConnectorReleaseCodec.executable(name));
        if (status.size === 0n || status.size > BigInt(ConnectorReleaseCodec.maximum(name))) {
            throw new Error('Release artifact exceeds its bound');
        }
        const artifact: ConnectorReleaseArtifact = { name, sizeBytes: status.size, sha256: '' };
        return { ...artifact, sha256: await this.#transfer(path, null, artifact, signal) };
    }
    /** Protected source identity, finite size and digest are checked without executing or buffering the artifact. */
    public static async verify(
        directory: string,
        artifact: ConnectorReleaseArtifact,
        signal: AbortSignal,
    ): Promise<void> {
        if (process.platform === 'win32') {
            signal.throwIfAborted();
            const metadata: ReturnType<typeof WindowsStateOwner.artifact> =
                WindowsStateOwner.artifact(
                    await WindowsStateOwner.request(WindowsStateOperation.ArtifactVerify, {
                        path: join(directory, artifact.name),
                        maximumBytes: ConnectorReleaseCodec.maximum(artifact.name),
                        sizeBytes: artifact.sizeBytes,
                        sha256: artifact.sha256,
                    }),
                    ConnectorReleaseCodec.maximum(artifact.name),
                );
            if (metadata.sizeBytes !== artifact.sizeBytes || metadata.sha256 !== artifact.sha256) {
                throw new Error('Connector release digest changed');
            }
            signal.throwIfAborted();
            return;
        }
        if (
            (await this.#transfer(join(directory, artifact.name), null, artifact, signal)) !==
            artifact.sha256
        ) {
            throw new Error('Connector release digest changed');
        }
    }
    /** Existing final files must match; only the current intent's exact partial leaf can be removed. */
    public static async install(
        source: string,
        owner: ConnectorPrivateDirectory,
        artifact: ConnectorReleaseArtifact,
        signal: AbortSignal,
        replace: boolean = false,
    ): Promise<void> {
        if (process.platform === 'win32') {
            signal.throwIfAborted();
            await owner.installArtifact(
                source,
                artifact.name,
                artifact.sizeBytes,
                artifact.sha256,
                ConnectorReleaseCodec.maximum(artifact.name),
                replace,
            );
            signal.throwIfAborted();
            return;
        }
        const final: string = owner.file(artifact.name);
        const temporary: string = owner.file(artifact.name + '.partial');
        try {
            const status: BigIntStats = await lstat(temporary, { bigint: true });
            ProtectedArtifact.trusted(status, false);
            if (
                status.size > BigInt(ConnectorReleaseCodec.maximum(artifact.name)) ||
                (status.mode & 0o077n) !== 0n
            ) {
                throw new Error('Invalid connector release partial');
            }
            await rm(temporary);
        } catch (caught: unknown) {
            if (!this.#missing(caught)) {
                throw caught;
            }
        }
        if (await owner.exists(artifact.name)) {
            if (!replace) {
                await this.verify(owner.directory, artifact, signal);
                return;
            }
            ProtectedArtifact.trusted(
                await lstat(final, { bigint: true }),
                ConnectorReleaseCodec.executable(artifact.name),
            );
        }
        const output: FileHandle = await open(
            temporary,
            'wx',
            ConnectorReleaseCodec.executable(artifact.name) ? 0o700 : 0o600,
        );
        try {
            if ((await this.#transfer(source, output, artifact, signal)) !== artifact.sha256) {
                throw new Error('Connector release digest changed');
            }
            await output.sync();
            await output.close();
            signal.throwIfAborted();
            if (replace) {
                await rename(temporary, final);
            } else {
                await link(temporary, final);
            }
        } finally {
            await output.close();
            await rm(temporary, { force: true });
        }
    }
    static async #transfer(
        path: string,
        output: FileHandle | null,
        artifact: ConnectorReleaseArtifact,
        signal: AbortSignal,
    ): Promise<string> {
        return await ProtectedArtifact.transfer(
            path,
            output,
            {
                sizeBytes: artifact.sizeBytes,
                maximumBytes: ConnectorReleaseCodec.maximum(artifact.name),
                executable: ConnectorReleaseCodec.executable(artifact.name),
            },
            signal,
        );
    }
    static #missing(caught: unknown): boolean {
        return caught instanceof Error && 'code' in caught && caught.code === 'ENOENT';
    }
}
