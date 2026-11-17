// SPDX-FileCopyrightText: 2026 Nerva contributors
// SPDX-License-Identifier: LicenseRef-Proprietary

import { createHash } from 'node:crypto';
import { mkdir, readdir, readFile, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { ConnectorBuildArtifact } from './ConnectorBuildArtifact.ts';

/** Windows processor architectures the setup program is built for. */
export const ConnectorWindowsArchitecture = {
    X64: 'x64',
    Arm64: 'arm64',
} as const;
/** Allowed values derive from the runtime mapping. */
export type ConnectorWindowsArchitecture =
    (typeof ConnectorWindowsArchitecture)[keyof typeof ConnectorWindowsArchitecture];

/** The cached, checked files the setup program bundles as its Node runtime. */
export interface ConnectorWindowsNodeFiles {
    readonly node: string;
    readonly license: string;
}

/** One pinned download. */
interface PinnedDownload {
    readonly url: string;
    readonly sha256: string;
    readonly file: string;
}

/**
 * Supplies the official Node.js build the Windows setup program bundles, pinned by version and SHA-256.
 *
 * @remarks
 * The digests come from the Node.js release's SHASUMS256.txt and the LICENSE at the release tag. A download is
 * accepted only when its SHA-256 matches; it is cached in the build's own directory and reused, and cached files of
 * any other version are removed so old runtimes do not pile up. Updating Node means changing the version and all
 * three digests together.
 */
export class ConnectorWindowsNodeRuntime {
    /** The bundled Node.js version; it must satisfy package.json engines. */
    public static readonly version: string = '26.12.1';
    static readonly #node: Readonly<Record<ConnectorWindowsArchitecture, string>> = {
        x64: '1c63f1417e2e26d83ca9a9ec1d548524ab1305bc7209d90ebca56257ff0d84ed',
        arm64: '7384299eeb99f419acaa4142771689fbca72e1c942f8da02b7928ffe1744e3ff',
    };
    static readonly #license: string =
        '8e603aa87c70d36e497004f0dec63111511cb61b7d65ace12e10ea791599286c';
    static readonly #maximumBytes: number = 268435456;

    /**
     * Returns the checked node.exe and Node license, downloading them once into `cache`.
     *
     * @param cache - The build-owned cache directory
     * @param architecture - The Windows architecture to bundle
     */
    public static async obtain(
        cache: string,
        architecture: ConnectorWindowsArchitecture,
    ): Promise<ConnectorWindowsNodeFiles> {
        await mkdir(cache, { recursive: true, mode: 0o700 });
        const version: string = this.version;
        const downloads: readonly PinnedDownload[] = Object.values(
            ConnectorWindowsArchitecture,
        ).map((each: ConnectorWindowsArchitecture): PinnedDownload => ({
            url: `https://nodejs.org/dist/v${version}/win-${each}/node.exe`,
            sha256: this.#node[each],
            file: join(cache, `node-v${version}-win-${each}.exe`),
        }));
        const license: PinnedDownload = {
            url: `https://raw.githubusercontent.com/nodejs/node/v${version}/LICENSE`,
            sha256: this.#license,
            file: join(cache, `node-v${version}-LICENSE.txt`),
        };
        const current: ReadonlySet<string> = new Set(
            [...downloads, license].map((pin: PinnedDownload): string => pin.file),
        );
        for (const name of await readdir(cache)) {
            if (!current.has(join(cache, name))) {
                await rm(join(cache, name), { force: true, recursive: true });
            }
        }
        const selected: PinnedDownload | undefined = downloads.find(
            (pin: PinnedDownload): boolean => pin.file.endsWith(`-win-${architecture}.exe`),
        );
        if (selected === undefined) {
            throw new Error('Unsupported Windows architecture');
        }
        await this.#ensure(selected);
        await this.#ensure(license);
        return { node: selected.file, license: license.file };
    }

    static async #ensure(pin: PinnedDownload): Promise<void> {
        try {
            if (this.#digest(await readFile(pin.file)) === pin.sha256) {
                return;
            }
        } catch (caught: unknown) {
            if (!(caught instanceof Error) || !('code' in caught) || caught.code !== 'ENOENT') {
                throw caught;
            }
        }
        const response: Response = await fetch(pin.url, {
            signal: AbortSignal.timeout(300000),
            redirect: 'follow',
        });
        if (!response.ok) {
            throw new Error(
                `Downloading ${pin.url} failed with HTTP ${response.status.toString()}`,
            );
        }
        const declared: number = Number(response.headers.get('content-length') ?? '0');
        if (declared > this.#maximumBytes) {
            throw new Error(`Download ${pin.url} is larger than expected`);
        }
        const bytes: Buffer = Buffer.from(await response.arrayBuffer());
        if (bytes.byteLength > this.#maximumBytes || this.#digest(bytes) !== pin.sha256) {
            throw new Error(`Download ${pin.url} does not match its pinned SHA-256`);
        }
        await ConnectorBuildArtifact.publish(pin.file, bytes, 0o600);
    }

    static #digest(bytes: Buffer): string {
        return createHash('sha256').update(bytes).digest('hex');
    }
}
