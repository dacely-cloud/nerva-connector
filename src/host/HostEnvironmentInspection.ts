// SPDX-FileCopyrightText: 2026 Nerva contributors
// SPDX-License-Identifier: LicenseRef-Proprietary

import { constants, type Stats } from 'node:fs';
import { access, lstat, stat } from 'node:fs/promises';
import { isAbsolute, sep } from 'node:path';
import {
    ConnectorHostErrorCode,
    ConnectorHostPlatform,
} from 'nerva-connector-protocol/protocol/ConnectorHost.js';
import { HostOperationError } from './HostOperationError.js';
import { HostEnvironmentValidation } from './HostEnvironmentValidation.js';
import {
    HostEnvironmentLimits,
    type HostEnvironmentReport,
    type HostEnvironmentRequest,
    type HostEnvironmentSource,
} from './HostEnvironmentTypes.js';

/** One inspection's search inputs are read once so every program sees the same PATH snapshot. */
interface HostEnvironmentSearch {
    readonly windows: boolean;
    readonly directories: readonly string[];
    readonly extensions: readonly string[];
    readonly foldedExtensions: readonly string[];
}

/**
 * Native PATH and variable presence inspection without a subprocess, shell, Python, PowerShell or registry.
 *
 * @remarks
 * Semantics follow `shutil.which(name)` and `bool(os.environ.get(name))` without any current-directory
 * search: empty and relative PATH entries are ignored, only the first 1024 PATH entries are
 * considered and exact duplicate directories are probed once. Directories that do not exist are
 * skipped before candidate probes. Absence errors (missing, denied, looping or invalid names) mean
 * not found; any other filesystem failure fails the whole inspection instead of reporting a guess.
 * At most four filesystem probes are outstanding and every probe rechecks the abort signal.
 */
export class HostEnvironmentInspection {
    static readonly #defaultExtensions: string = '.COM;.EXE;.BAT;.CMD';
    static readonly #extensionCharacters: RegExp = /[\0/\\]/u;
    static readonly #absent: ReadonlySet<string> = new Set([
        'ENOENT',
        'ENOTDIR',
        'EACCES',
        'EPERM',
        'ELOOP',
        'ENAMETOOLONG',
        'EINVAL',
    ]);
    readonly #source: HostEnvironmentSource;

    /** The source selects platform semantics and variable values; probes always use the real filesystem. */
    public constructor(source: HostEnvironmentSource) {
        this.#source = source;
    }

    /** Inspect the connector runtime's own platform and `process.env`, which process_start inherits by default. */
    public static runtime(platform: NodeJS.Platform = process.platform): HostEnvironmentInspection {
        const mapped: ConnectorHostPlatform | null =
            platform === 'win32'
                ? ConnectorHostPlatform.Windows
                : platform === 'darwin'
                  ? ConnectorHostPlatform.MacOs
                  : platform === 'linux'
                    ? ConnectorHostPlatform.Linux
                    : null;
        if (mapped === null) {
            throw new HostOperationError(
                ConnectorHostErrorCode.Unsupported,
                'Environment inspection is unavailable on this platform',
                true,
            );
        }
        return new HostEnvironmentInspection({
            platform: mapped,
            variable: (name: string): string | undefined => {
                const value: unknown = Reflect.get(process.env, name);
                return typeof value === 'string' ? value : undefined;
            },
        });
    }

    /** Return presence flags aligned with request order; resolved paths and values never leave this method. */
    public async inspect(
        request: HostEnvironmentRequest,
        signal: AbortSignal,
    ): Promise<HostEnvironmentReport> {
        const valid: HostEnvironmentRequest = HostEnvironmentValidation.request(
            request.programs,
            request.variables,
        );
        signal.throwIfAborted();
        const platform: ConnectorHostPlatform = this.#source.platform;
        const windows: boolean = platform === ConnectorHostPlatform.Windows;
        const variables: readonly boolean[] = valid.variables.map((name: string): boolean => {
            const value: string | undefined = this.#source.variable(name);
            return typeof value === 'string' && value.length > 0;
        });
        const extensions: readonly string[] = windows ? this.#extensions() : [];
        const search: HostEnvironmentSearch = {
            windows,
            directories:
                valid.programs.length === 0 ? [] : await this.#directories(windows, signal),
            extensions,
            foldedExtensions: extensions.map((extension: string): string =>
                extension.toLowerCase(),
            ),
        };
        const programs: readonly boolean[] = await this.#pool(
            valid.programs,
            (name: string, active: AbortSignal): Promise<boolean> =>
                this.#program(name, search, active),
            signal,
        );
        return Object.freeze({
            platform,
            programs: Object.freeze(programs),
            variables: Object.freeze(variables),
        });
    }

    async #directories(windows: boolean, signal: AbortSignal): Promise<readonly string[]> {
        const path: string | undefined = this.#source.variable('PATH');
        if (typeof path !== 'string' || path.length === 0) {
            return [];
        }
        const entries: string[] = [];
        const seen: Set<string> = new Set();
        for (const entry of path.split(windows ? ';' : ':', HostEnvironmentLimits.pathEntries)) {
            const directory: string =
                windows && entry.length >= 2 && entry.startsWith('"') && entry.endsWith('"')
                    ? entry.slice(1, -1)
                    : entry;
            if (
                directory.length === 0 ||
                directory.includes('\0') ||
                !isAbsolute(directory) ||
                seen.has(directory)
            ) {
                continue;
            }
            seen.add(directory);
            entries.push(directory);
        }
        const usable: readonly boolean[] = await this.#pool(
            entries,
            (directory: string, active: AbortSignal): Promise<boolean> =>
                this.#directory(directory, active),
            signal,
        );
        return entries.filter((_directory: string, index: number): boolean => usable[index]);
    }

    /** Only proven missing or non-directory PATH entries are skipped; other failures stay for candidate probes. */
    async #directory(directory: string, signal: AbortSignal): Promise<boolean> {
        signal.throwIfAborted();
        try {
            return (await stat(directory)).isDirectory();
        } catch (caught: unknown) {
            const code: unknown = caught instanceof Error ? Reflect.get(caught, 'code') : undefined;
            return code !== 'ENOENT' && code !== 'ENOTDIR';
        }
    }

    #extensions(): readonly string[] {
        const configured: string | undefined = this.#source.variable('PATHEXT');
        const source: string =
            typeof configured === 'string' && configured.length > 0
                ? configured
                : HostEnvironmentInspection.#defaultExtensions;
        const extensions: string[] = [];
        for (const extension of source.split(';', HostEnvironmentLimits.pathEntries)) {
            if (
                extension.length !== 0 &&
                !HostEnvironmentInspection.#extensionCharacters.test(extension)
            ) {
                extensions.push(extension);
                if (extensions.length === HostEnvironmentLimits.extensions) {
                    break;
                }
            }
        }
        return extensions;
    }

    async #program(
        name: string,
        search: HostEnvironmentSearch,
        signal: AbortSignal,
    ): Promise<boolean> {
        const candidates: readonly string[] = search.windows
            ? this.#windowsNames(name, search)
            : [name];
        for (const directory of search.directories) {
            const prefix: string =
                directory.endsWith(sep) || (sep === '\\' && directory.endsWith('/'))
                    ? directory
                    : directory + sep;
            for (const candidate of candidates) {
                if (
                    search.windows
                        ? await this.#windowsCandidate(prefix + candidate, signal)
                        : await this.#posixCandidate(prefix + candidate, signal)
                ) {
                    return true;
                }
            }
        }
        return false;
    }

    #windowsNames(name: string, search: HostEnvironmentSearch): readonly string[] {
        const folded: string = name.toLowerCase();
        if (
            search.foldedExtensions.some((extension: string): boolean => folded.endsWith(extension))
        ) {
            return [name];
        }
        return search.extensions.map((extension: string): string => name + extension);
    }

    async #posixCandidate(path: string, signal: AbortSignal): Promise<boolean> {
        signal.throwIfAborted();
        let entry: Stats;
        try {
            entry = await stat(path);
        } catch (caught: unknown) {
            return this.#missing(caught);
        }
        if (!entry.isFile()) {
            return false;
        }
        signal.throwIfAborted();
        try {
            await access(path, constants.X_OK);
            return true;
        } catch (caught: unknown) {
            return this.#missing(caught);
        }
    }

    /**
     * A Windows candidate is found when the followed entry is a regular file, or when a link entry
     * cannot be followed.
     *
     * @remarks
     * App Execution Aliases such as `%LOCALAPPDATA%\Microsoft\WindowsApps\python.exe` are reparse
     * points that may not stat normally, so a link whose target cannot be followed still counts.
     * Directories, devices and other special entries never count, followed or not. The entry is
     * inspected with lstat first, so a missing candidate costs one probe; only links are followed.
     */
    async #windowsCandidate(path: string, signal: AbortSignal): Promise<boolean> {
        signal.throwIfAborted();
        let entry: Stats;
        try {
            entry = await lstat(path);
        } catch (caught: unknown) {
            return this.#missing(caught);
        }
        if (!entry.isSymbolicLink()) {
            return entry.isFile();
        }
        signal.throwIfAborted();
        let followed: Stats | null;
        try {
            followed = await stat(path);
        } catch {
            followed = null;
        }
        return followed === null || followed.isFile() || followed.isSymbolicLink();
    }

    /** Absence errors mean not found; every other failure propagates instead of becoming a false answer. */
    #missing(caught: unknown): boolean {
        const code: unknown = caught instanceof Error ? Reflect.get(caught, 'code') : undefined;
        if (typeof code === 'string' && HostEnvironmentInspection.#absent.has(code)) {
            return false;
        }
        throw caught;
    }

    /** A fixed worker pool stops scheduling after the first failure and joins in-flight probes before rejecting. */
    async #pool<T>(
        items: readonly T[],
        task: (item: T, signal: AbortSignal) => Promise<boolean>,
        signal: AbortSignal,
    ): Promise<readonly boolean[]> {
        const results: boolean[] = new Array<boolean>(items.length).fill(false);
        if (items.length === 0) {
            return results;
        }
        const failures: unknown[] = [];
        const stop: AbortController = new AbortController();
        const active: AbortSignal = AbortSignal.any([signal, stop.signal]);
        const pending: IterableIterator<[number, T]> = items.entries();
        const worker: () => Promise<void> = async (): Promise<void> => {
            for (const [index, item] of pending) {
                if (failures.length !== 0) {
                    return;
                }
                try {
                    active.throwIfAborted();
                    results[index] = await task(item, active);
                } catch (caught: unknown) {
                    failures.push(caught);
                    stop.abort(caught);
                }
            }
        };
        await Promise.all(
            Array.from(
                { length: Math.min(HostEnvironmentLimits.probes, items.length) },
                (): Promise<void> => worker(),
            ),
        );
        if (failures.length !== 0) {
            throw failures[0];
        }
        return results;
    }
}
