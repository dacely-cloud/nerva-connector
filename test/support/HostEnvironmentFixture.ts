// SPDX-FileCopyrightText: 2026 Dacely <business@dacely.com>
// SPDX-License-Identifier: LicenseRef-Proprietary

import { chmod, mkdir, mkdtemp, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ConnectorHostPlatform } from 'nerva-connector-protocol/protocol/ConnectorHost.js';
import type { HostEnvironmentSource } from '../../src/host/HostEnvironmentTypes.js';

/** An injected environment records every lookup so tests can prove which variables were read. */
export interface HostEnvironmentFixtureSource extends HostEnvironmentSource {
    readonly lookups: readonly string[];
}

/** Each environment test owns one temporary search tree and removes it on every exit. */
export class HostEnvironmentFixture implements AsyncDisposable {
    private constructor(public readonly root: string) {}

    /** The tree lives beneath the OS temporary directory, never the repository or current directory. */
    public static async create(): Promise<HostEnvironmentFixture> {
        return new HostEnvironmentFixture(await mkdtemp(join(tmpdir(), 'nerva-environment-')));
    }

    /** Create one empty search directory beneath the owned root. */
    public async directory(name: string): Promise<string> {
        const path: string = join(this.root, name);
        await mkdir(path);
        return path;
    }

    /** Create a regular file with exact permission bits, independent of the process umask. */
    public async file(directory: string, name: string, mode: number): Promise<string> {
        const path: string = join(directory, name);
        await writeFile(path, '', { flag: 'wx', mode });
        await chmod(path, mode);
        return path;
    }

    /** Create a symbolic link whose target may intentionally be missing. */
    public async link(directory: string, name: string, target: string): Promise<string> {
        const path: string = join(directory, name);
        await symlink(target, path);
        return path;
    }

    /** Variables use exact names on POSIX and case-insensitive names on Windows, like `process.env`. */
    public source(
        platform: ConnectorHostPlatform,
        values: Readonly<Record<string, string>>,
    ): HostEnvironmentFixtureSource {
        const windows: boolean = platform === ConnectorHostPlatform.Windows;
        const entries: ReadonlyMap<string, string> = new Map(
            Object.entries(values).map(([name, value]: [string, string]): [string, string] => [
                windows ? name.toUpperCase() : name,
                value,
            ]),
        );
        const lookups: string[] = [];
        return {
            platform,
            lookups,
            variable: (name: string): string | undefined => {
                lookups.push(name);
                return entries.get(windows ? name.toUpperCase() : name);
            },
        };
    }

    /** Cleanup removes every task-owned file, link and directory. */
    public async [Symbol.asyncDispose](): Promise<void> {
        await rm(this.root, { recursive: true, force: true });
    }
}
