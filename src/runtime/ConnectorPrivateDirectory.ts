// SPDX-FileCopyrightText: 2026 Nerva contributors
// SPDX-License-Identifier: LicenseRef-Proprietary

import { createHash } from 'node:crypto';
import { constants, type BigIntStats } from 'node:fs';
import { lstat, open, link, rename, rm, readdir, opendir, type FileHandle } from 'node:fs/promises';
import type { Dir } from 'node:fs';
import { resolve, join } from 'node:path';
import { createServer, type Server, type Socket } from 'node:net';
import { ProtectedFiles } from '../local/ProtectedFiles.js';
import { ConnectorDarwinStateLock } from './ConnectorDarwinStateLock.js';
import { WindowsStateOwner } from '../windows/WindowsStateOwner.js';
import type { WindowsStateArtifactMetadata } from '../windows/WindowsStateArtifactMetadata.js';
import {
    WindowsStateOperation,
    WindowsStatePurpose,
    WindowsStateError,
    WindowsStateFailure,
    type WindowsStateResponse,
} from '../windows/WindowsStateProtocol.js';

enum DirectoryPlatform {
    Linux = 'linux',
    Darwin = 'darwin',
    Windows = 'windows',
}
interface LinuxDirectoryOwner {
    readonly platform: DirectoryPlatform.Linux;
    readonly handle: FileHandle;
    readonly lock: Server;
}
/** macOS keeps the pinned directory descriptor and a kernel `flock` held through an open lock file. */
interface DarwinDirectoryOwner {
    readonly platform: DirectoryPlatform.Darwin;
    readonly handle: FileHandle;
    readonly lock: FileHandle;
}
interface WindowsDirectoryOwner {
    readonly platform: DirectoryPlatform.Windows;
    readonly lease: string;
    readonly purpose: WindowsStatePurpose;
}
type DirectoryOwner = LinuxDirectoryOwner | DarwinDirectoryOwner | WindowsDirectoryOwner;

/** Identity, pairing, file results and command results have independently selected exclusive owners. */
export enum ConnectorDirectoryPurpose {
    Installation = 'installation',
    Runtime = 'runtime',
    Service = 'service',
    Native = 'native',
    Identity = 'identity',
    Files = 'files',
    Execution = 'execution',
    ExecutionInput = 'execution-input',
    Pairing = 'pairing',
    Workspaces = 'workspaces',
}

/** A pinned private directory and kernel-owned lock own bounded atomic publication and cleanup. */
export class ConnectorPrivateDirectory implements AsyncDisposable {
    #closed: boolean = false;
    readonly #owner: DirectoryOwner;
    private constructor(
        public readonly directory: string,
        owner: DirectoryOwner,
    ) {
        this.#owner = owner;
    }
    /** Existing canonical owner-private directories are required; no installation permission is silently repaired. */
    public static async open(
        directory: string,
        purpose: ConnectorDirectoryPurpose,
    ): Promise<ConnectorPrivateDirectory> {
        if (process.platform === 'win32') {
            const selected: WindowsStatePurpose | undefined = Object.values(
                WindowsStatePurpose,
            ).find((value: WindowsStatePurpose): boolean => value.valueOf() === purpose.valueOf());
            if (selected === undefined) {
                throw new WindowsStateError(WindowsStateFailure.Invalid);
            }
            const result: WindowsStateResponse = await WindowsStateOwner.request(
                WindowsStateOperation.Open,
                { path: ProtectedFiles.path(directory), purpose: selected },
            );
            if (result.lease === null) {
                throw new WindowsStateError(WindowsStateFailure.Invalid);
            }
            return new ConnectorPrivateDirectory(directory, {
                platform: DirectoryPlatform.Windows,
                lease: result.lease,
                purpose: selected,
            });
        }
        if (
            (process.platform !== 'linux' && process.platform !== 'darwin') ||
            resolve(ProtectedFiles.path(directory)) !== directory
        ) {
            throw new Error('Connector state requires a canonical Linux or macOS directory');
        }
        if (!Object.values(ConnectorDirectoryPurpose).includes(purpose)) {
            throw new Error('Invalid connector directory purpose');
        }
        await ProtectedFiles.directory(directory);
        const status: BigIntStats = await lstat(directory, { bigint: true });
        if (status.uid !== BigInt(process.getuid?.() ?? -1) || (status.mode & 0o077n) !== 0n) {
            throw new Error('Connector state directory must be owner-private');
        }
        const digest: string = createHash('sha256')
            .update(JSON.stringify([purpose, status.dev.toString(), status.ino.toString()]))
            .digest('hex');
        if (process.platform === 'darwin') {
            return await this.#darwin(directory, status, digest);
        }
        const lock: Server = createServer((socket: Socket): void => {
            socket.destroy();
        });
        lock.maxConnections = 1;
        let handle: FileHandle | null = null;
        try {
            const ready: PromiseWithResolvers<undefined> = Promise.withResolvers<undefined>();
            lock.once('error', ready.reject);
            lock.listen('\0nerva-state-' + digest, (): void => ready.resolve(undefined));
            await ready.promise;
            lock.removeListener('error', ready.reject);
            lock.on('error', (): void => {
                lock.close();
            });
            handle = await open(
                directory,
                constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW,
            );
            const pinned: BigIntStats = await handle.stat({ bigint: true });
            if (pinned.dev !== status.dev || pinned.ino !== status.ino) {
                throw new Error('Connector state directory changed');
            }
            return new ConnectorPrivateDirectory(directory, {
                platform: DirectoryPlatform.Linux,
                handle,
                lock,
            });
        } catch (caught: unknown) {
            try {
                await handle?.close();
            } finally {
                if (lock.listening) {
                    await this.#unlock(lock);
                }
            }
            throw caught;
        }
    }
    /** Public references use the installed canonical path; actual I/O remains beneath the retained directory descriptor. */
    public file(name: string): string {
        this.#name(name);
        return join(this.directory, name);
    }
    /** Presence never implies validity; callers must decode an existing state instead of recreating it. */
    public async exists(name: string): Promise<boolean> {
        if (this.#owner.platform === DirectoryPlatform.Windows) {
            const result: WindowsStateResponse = await WindowsStateOwner.request(
                WindowsStateOperation.Exists,
                { lease: this.#lease(), name: this.#name(name) },
            );
            if (result.exists === null) {
                throw new WindowsStateError(WindowsStateFailure.Invalid);
            }
            return result.exists;
        }
        try {
            await lstat(await this.#resolve(name));
            return true;
        } catch (caught: unknown) {
            if (caught instanceof Error && 'code' in caught && caught.code === 'ENOENT') {
                return false;
            }
            throw caught;
        }
    }
    /** Every normal leaf is a bounded, protected, single-link regular file. */
    public async read(name: string, maximum: number): Promise<Buffer> {
        if (this.#owner.platform === DirectoryPlatform.Windows) {
            return WindowsStateOwner.bytes(
                await WindowsStateOwner.request(WindowsStateOperation.Read, {
                    lease: this.#lease(),
                    name: this.#name(name),
                    maximumBytes: maximum,
                }),
                maximum,
            );
        }
        const path: string = await this.#resolve(name);
        const value: Buffer = await ProtectedFiles.read(path, maximum, true);
        const status: BigIntStats = await lstat(path, { bigint: true });
        if (!status.isFile() || status.nlink !== 1n) {
            value.fill(0);
            throw new Error('Connector state must be a single-link regular file');
        }
        return value;
    }
    /** Explicit local owners remove only a validated current leaf and durably sync its absence. */
    public async remove(name: string, maximum: number): Promise<void> {
        if (this.#owner.platform === DirectoryPlatform.Windows) {
            await WindowsStateOwner.request(WindowsStateOperation.Remove, {
                lease: this.#lease(),
                name: this.#name(name),
                maximumBytes: maximum,
            });
            return;
        }
        const bytes: Buffer = await this.read(name, maximum);
        bytes.fill(0);
        await rm(await this.#resolve(name));
        await this.#owner.handle.sync();
    }
    /** Only a known owned partial is cleaned after acquiring its purpose lock; interrupted publication retains the final file. */
    public async cleanPartial(name: string, maximum: number): Promise<void> {
        if (this.#owner.platform === DirectoryPlatform.Windows) {
            await WindowsStateOwner.request(WindowsStateOperation.CleanPartial, {
                lease: this.#lease(),
                name: this.#name(name),
                maximumBytes: maximum,
            });
            return;
        }
        const path: string = await this.#resolve(name + '.partial');
        try {
            const value: Buffer = await ProtectedFiles.read(path, maximum, true);
            value.fill(0);
        } catch (caught: unknown) {
            if (caught instanceof Error && 'code' in caught && caught.code === 'ENOENT') {
                return;
            }
            throw caught;
        }
        await rm(path);
        await this.#owner.handle.sync();
    }
    /** New bytes are synced before no-overwrite publication or replacement of an already valid owned file. */
    public async write(
        name: string,
        bytes: Buffer,
        maximum: number,
        initialize: boolean,
    ): Promise<void> {
        if (
            !Number.isSafeInteger(maximum) ||
            maximum < 1 ||
            maximum > 1048576 ||
            bytes.byteLength > maximum
        ) {
            throw new Error('Connector state exceeds its bound');
        }
        if (this.#owner.platform === DirectoryPlatform.Windows) {
            await WindowsStateOwner.request(WindowsStateOperation.Write, {
                lease: this.#lease(),
                name: this.#name(name),
                maximumBytes: maximum,
                dataBase64: bytes.toString('base64'),
                initialize,
            });
            return;
        }
        const path: string = await this.#resolve(name);
        const temporary: string = await this.#resolve(name + '.partial');
        const output: FileHandle = await open(temporary, 'wx', 0o600);
        try {
            await output.writeFile(bytes);
            await output.sync();
            await output.close();
            if (initialize) {
                await link(temporary, path);
            } else {
                const existing: Buffer = await this.read(name, maximum);
                existing.fill(0);
                await rename(temporary, path);
            }
            await this.#owner.handle.sync();
        } finally {
            try {
                await output.close();
            } finally {
                try {
                    await rm(temporary, { force: true });
                } finally {
                    await this.#owner.handle.sync();
                }
            }
        }
    }
    /** Windows release copies remain beneath this live installation lease with native streamed verification. */
    public async installArtifact(
        source: string,
        name: string,
        sizeBytes: bigint,
        sha256: string,
        maximumBytes: number,
        replace: boolean,
    ): Promise<void> {
        if (
            this.#owner.platform !== DirectoryPlatform.Windows ||
            this.#owner.purpose !== WindowsStatePurpose.Installation
        ) {
            throw new WindowsStateError(WindowsStateFailure.Invalid);
        }
        const response: WindowsStateResponse = await WindowsStateOwner.request(
            WindowsStateOperation.ArtifactInstall,
            {
                path: source,
                lease: this.#lease(),
                name: this.#name(name),
                sizeBytes,
                sha256,
                maximumBytes,
                replace,
            },
        );
        const result: WindowsStateArtifactMetadata = WindowsStateOwner.artifact(
            response,
            maximumBytes,
        );
        if (result.sizeBytes !== sizeBytes || result.sha256 !== sha256) {
            throw new WindowsStateError(WindowsStateFailure.Invalid);
        }
    }
    /** Release the directory and kernel lock only after owned writes have been joined by the caller. */
    public async [Symbol.asyncDispose](): Promise<void> {
        if (!this.#closed) {
            this.#closed = true;
            if (this.#owner.platform === DirectoryPlatform.Windows) {
                await WindowsStateOwner.request(WindowsStateOperation.Close, {
                    lease: this.#owner.lease,
                });
                return;
            }
            try {
                await this.#owner.handle.close();
            } finally {
                if (this.#owner.platform === DirectoryPlatform.Darwin) {
                    await this.#owner.lock.close();
                } else {
                    await ConnectorPrivateDirectory.#unlock(this.#owner.lock);
                }
            }
        }
    }
    /** Enumeration is owned by the same retained directory as protected publication and reads. */
    public async list(): Promise<readonly string[]> {
        if (this.#closed) {
            throw new Error('Connector state ownership is closed');
        }
        if (this.#owner.platform === DirectoryPlatform.Windows) {
            const result: WindowsStateResponse = await WindowsStateOwner.request(
                WindowsStateOperation.List,
                { lease: this.#lease() },
            );
            if (result.names === null) {
                throw new WindowsStateError(WindowsStateFailure.Invalid);
            }
            return result.names;
        }
        return await readdir(await this.#listing());
    }
    /** Initial installation can reject nonempty state with one bounded directory read rather than enumerating retained archives. */
    public async empty(): Promise<boolean> {
        if (this.#closed) {
            throw new Error('Connector state ownership is closed');
        }
        if (this.#owner.platform === DirectoryPlatform.Windows) {
            return (await this.list()).length === 0;
        }
        const directory: Dir = await opendir(await this.#listing(), { bufferSize: 1 });
        try {
            return (await directory.read()) === null;
        } finally {
            await directory.close();
        }
    }
    #name(name: string): string {
        if (
            name.length === 0 ||
            name.length > 255 ||
            name === '.' ||
            name === '..' ||
            name.includes('/') ||
            (this.#owner.platform === DirectoryPlatform.Windows &&
                (/[<>:"\\|?*]/u.test(name) ||
                    /[. ]$/u.test(name) ||
                    /^(?:CON|PRN|AUX|NUL|COM[1-9]|LPT[1-9])(?:\.|$)/iu.test(name))) ||
            Array.from(name).some((character: string): boolean => character.charCodeAt(0) < 32)
        ) {
            throw new Error('Invalid connector state basename');
        }
        return name;
    }
    /**
     * The path for one leaf beneath the owned directory.
     *
     * @remarks
     * Linux addresses the leaf through the retained descriptor in `/proc`. macOS has no such path, so the
     * canonical path is used only after confirming it still names the pinned directory; the directory is
     * owner-private, so only this user or the administrator could swap it in between.
     */
    async #resolve(name: string): Promise<string> {
        this.#name(name);
        return (await this.#listing()) + '/' + name;
    }
    /** The directory path for enumeration, bound to the retained descriptor. */
    async #listing(): Promise<string> {
        if (this.#closed) {
            throw new Error('Connector state ownership is closed');
        }
        if (this.#owner.platform === DirectoryPlatform.Linux && this.#owner.lock.listening) {
            return '/proc/self/fd/' + this.#owner.handle.fd.toString();
        }
        if (this.#owner.platform === DirectoryPlatform.Darwin) {
            const [current, pinned]: readonly [BigIntStats, BigIntStats] = await Promise.all([
                lstat(this.directory, { bigint: true }),
                this.#owner.handle.stat({ bigint: true }),
            ]);
            if (
                !current.isDirectory() ||
                current.dev !== pinned.dev ||
                current.ino !== pinned.ino
            ) {
                throw new Error('Connector state directory changed');
            }
            return this.directory;
        }
        throw new Error('Connector state ownership is closed');
    }
    #lease(): string {
        if (this.#closed || this.#owner.platform !== DirectoryPlatform.Windows) {
            throw new WindowsStateError(WindowsStateFailure.Invalid);
        }
        return this.#owner.lease;
    }
    /** The macOS lock is taken before the directory is pinned and released if pinning fails. */
    static async #darwin(
        directory: string,
        status: BigIntStats,
        digest: string,
    ): Promise<ConnectorPrivateDirectory> {
        const lock: FileHandle = await ConnectorDarwinStateLock.acquire('nerva-state-' + digest);
        let handle: FileHandle | null = null;
        try {
            handle = await open(
                directory,
                constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW,
            );
            const pinned: BigIntStats = await handle.stat({ bigint: true });
            if (pinned.dev !== status.dev || pinned.ino !== status.ino) {
                throw new Error('Connector state directory changed');
            }
            return new ConnectorPrivateDirectory(directory, {
                platform: DirectoryPlatform.Darwin,
                handle,
                lock,
            });
        } catch (caught: unknown) {
            try {
                await handle?.close();
            } finally {
                await lock.close();
            }
            throw caught;
        }
    }
    static async #unlock(lock: Server): Promise<void> {
        const done: PromiseWithResolvers<undefined> = Promise.withResolvers<undefined>();
        lock.close((error?: Error): void =>
            error === undefined ? done.resolve(undefined) : done.reject(error),
        );
        await done.promise;
    }
}
