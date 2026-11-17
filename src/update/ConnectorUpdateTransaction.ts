// SPDX-FileCopyrightText: 2026 Nerva contributors
// SPDX-License-Identifier: LicenseRef-Proprietary

import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import type { BigIntStats } from 'node:fs';
import { lstat, link, mkdir, open, readdir, rm, type FileHandle } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { promisify } from 'node:util';
import { ConnectorUpdateDownload } from './ConnectorUpdateDownload.js';
import { ConnectorUpdateHelper } from './ConnectorUpdateHelper.js';
import { ConnectorUpdatePackage } from './ConnectorUpdatePackage.js';
import { ConnectorUpdatePaths } from './ConnectorUpdatePaths.js';
import {
    ConnectorUpdatePlatform,
    type ConnectorUpdateRelease,
    type ConnectorUpdateSettings,
} from './ConnectorUpdateProtocol.js';

/** Owns one marked staging directory and an atomic program exchange; account state is never part of this transaction. */
export class ConnectorUpdateTransaction implements AsyncDisposable {
    readonly #work: string;
    readonly #lock: string;
    readonly #marker: string;
    #next: string | null = null;
    #exchanged: boolean = false;
    #retained: boolean = false;
    #created: boolean = false;
    #lockOwned: boolean = false;
    #previousDevice: bigint | null = null;
    #previousInode: bigint | null = null;

    /** The native application root is resolved by the installed launcher, never supplied by an update manifest. */
    public constructor(
        public readonly root: string,
        public readonly settings: ConnectorUpdateSettings,
    ) {
        this.#work = join(
            dirname(root),
            '.nerva-update-' + createHash('sha256').update(root).digest('hex').slice(0, 20),
        );
        this.#lock = root + '.install-lock';
        this.#marker = 'nerva-connector-update-v1\n' + root + '\n';
    }

    /** Startup under the kernel lease removes only this updater's recognized crash leftovers. */
    public async recover(): Promise<void> {
        await ConnectorUpdatePaths.directory(this.root);
        if (await ConnectorUpdatePaths.exists(this.#lock)) {
            if (
                (await ConnectorUpdatePaths.read(this.#lock, 8192)).toString('utf8') !==
                this.#marker
            ) {
                throw new Error('Another installer owns this program location');
            }
            await rm(this.#lock);
        }
        if (await ConnectorUpdatePaths.exists(this.#work)) {
            await this.#owned();
            if (this.settings.platform === ConnectorUpdatePlatform.Mac) {
                await ConnectorUpdatePackage.detach(this.#work);
            }
            await rm(this.#work, { recursive: true });
        }
    }

    /** Network verification and offline preparation finish while the old connector continues running. */
    public async prepare(release: ConnectorUpdateRelease, signal: AbortSignal): Promise<void> {
        await this.recover();
        await this.#current(signal);
        await mkdir(this.#work, { mode: 0o700 });
        this.#created = true;
        const marker: FileHandle = await open(join(this.#work, 'owner'), 'wx', 0o600);
        try {
            await marker.writeFile(this.#marker);
            await marker.sync();
        } finally {
            await marker.close();
        }
        await link(join(this.#work, 'owner'), this.#lock);
        this.#lockOwned = true;
        const installer: string = join(this.#work, release.artifact.name);
        await ConnectorUpdateDownload.installer(this.settings, release, installer, signal);
        this.#next = await ConnectorUpdatePackage.stage(
            installer,
            this.#work,
            this.settings,
            signal,
        );
        await ConnectorUpdatePackage.smoke(this.#next, this.settings, release.version, signal);
    }

    /** The kernel swaps directory names in one operation; a failed post-swap launch check restores the old program atomically. */
    public async install(release: ConnectorUpdateRelease, signal: AbortSignal): Promise<void> {
        const next: string | null = this.#next;
        if (next === null) {
            throw new Error('No verified update is staged');
        }
        signal.throwIfAborted();
        const original: BigIntStats = await lstat(this.root, { bigint: true });
        const staged: BigIntStats = await lstat(next, { bigint: true });
        this.#previousDevice = original.dev;
        this.#previousInode = original.ino;
        const helper: string = join(
            ConnectorUpdatePackage.program(this.root, this.settings.platform),
            'nerva-connector-update',
        );
        await ConnectorUpdateHelper.verify(helper, this.settings);
        try {
            await promisify(execFile)(helper, [this.root, next], {
                timeout: 30000,
                maxBuffer: 4096,
                env: ConnectorUpdatePackage.environment(),
            });
        } catch (caught: unknown) {
            await this.#observe(original, staged);
            throw caught;
        }
        await this.#observe(original, staged);
        try {
            await ConnectorUpdatePackage.smoke(this.root, this.settings, release.version, signal);
            if (this.settings.platform === ConnectorUpdatePlatform.Mac) {
                await ConnectorUpdatePackage.macSignature(this.root, signal);
            }
        } catch (caught: unknown) {
            await this.rollback();
            throw caught;
        }
    }

    /** The previous program remains recoverable until exec has transferred supervision to the new version. */
    public retainForRestart(): void {
        if (!this.#exchanged) {
            throw new Error('No installed update can be retained');
        }
        this.#retained = true;
    }

    /** Re-exec failures restore the previous complete installation without reading or changing device identity. */
    public async rollback(): Promise<void> {
        if (!this.#exchanged || this.#next === null) {
            return;
        }
        const helper: string = join(
            ConnectorUpdatePackage.program(this.#next, this.settings.platform),
            'nerva-connector-update',
        );
        await ConnectorUpdateHelper.verify(helper, this.settings);
        try {
            await promisify(execFile)(helper, [this.root, this.#next], {
                timeout: 30000,
                maxBuffer: 4096,
                env: ConnectorUpdatePackage.environment(),
            });
        } finally {
            const current: BigIntStats = await lstat(this.root, { bigint: true });
            if (current.dev === this.#previousDevice && current.ino === this.#previousInode) {
                this.#exchanged = false;
                this.#retained = false;
            }
        }
    }

    /** Cancellation and failed checks remove only marked task-owned staging; successful exec leaves recovery to the next owner. */
    public async [Symbol.asyncDispose](): Promise<void> {
        if (this.#retained) {
            return;
        }
        await this.rollback();
        if (this.#created && (await ConnectorUpdatePaths.exists(this.#work))) {
            if (this.settings.platform === ConnectorUpdatePlatform.Mac) {
                await ConnectorUpdatePackage.detach(this.#work);
            }
            if (
                this.#lockOwned &&
                (await ConnectorUpdatePaths.exists(this.#lock)) &&
                (await ConnectorUpdatePaths.read(this.#lock, 8192)).toString('utf8') ===
                    this.#marker
            ) {
                await rm(this.#lock);
            }
            await rm(this.#work, { recursive: true });
            this.#created = false;
            this.#lockOwned = false;
        }
    }

    async #owned(): Promise<void> {
        await ConnectorUpdatePaths.directory(this.#work, true);
        if (
            (await ConnectorUpdatePaths.read(join(this.#work, 'owner'), 8192)).toString('utf8') !==
            this.#marker
        ) {
            throw new Error('Unrecognized update staging directory; preserving its contents');
        }
    }

    async #observe(original: BigIntStats, staged: BigIntStats): Promise<void> {
        const current: BigIntStats = await lstat(this.root, { bigint: true });
        if (current.dev === staged.dev && current.ino === staged.ino) {
            this.#exchanged = true;
        } else if (current.dev !== original.dev || current.ino !== original.ino) {
            throw new Error('Program location changed during atomic update');
        }
    }

    async #current(signal: AbortSignal): Promise<void> {
        if (this.settings.platform === ConnectorUpdatePlatform.Mac) {
            await ConnectorUpdatePackage.macSignature(this.root, signal);
            return;
        }
        const names: readonly string[] = await readdir(this.root);
        if (
            names.length !== this.settings.files.length ||
            names.some((name: string): boolean => !this.settings.files.includes(name))
        ) {
            throw new Error('Program directory contains unrelated files; automatic update refused');
        }
        for (const name of names) {
            if (!(await lstat(join(this.root, name))).isFile()) {
                throw new Error('Program directory contains a symlink or special file');
            }
        }
    }
}
