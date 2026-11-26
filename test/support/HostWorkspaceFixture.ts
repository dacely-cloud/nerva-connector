// SPDX-FileCopyrightText: 2026 Dacely <business@dacely.com>
// SPDX-License-Identifier: LicenseRef-Proprietary

import { mkdtemp, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { HostWorkspace } from '../../src/host/HostWorkspace.js';
import { HostWindowsBuild } from '../../src/host/HostWindowsBuild.js';
import type {
    HostWorkspaceAccess,
    HostWorkspaceAuthorization,
} from '../../src/host/HostWorkspaceTypes.js';

/** Each test owns one temporary tree and one runtime, both released even after assertion failure. */
export class HostWorkspaceFixture implements AsyncDisposable, HostWorkspaceAuthorization {
    public workspace: HostWorkspace | null = null;
    public allowed: boolean = true;
    public readonly checks: HostWorkspaceAccess[] = [];

    private constructor(public readonly directory: string) {}

    /** Windows runs the same tests with the verified current compiled job broker. */
    public static async create(): Promise<HostWorkspaceFixture> {
        const fixture: HostWorkspaceFixture = new HostWorkspaceFixture(
            await mkdtemp(join(tmpdir(), 'nerva-host-test-')),
        );
        try {
            fixture.workspace = await HostWorkspace.create({
                directory: fixture.directory,
                authorization: fixture,
                windowsLauncher:
                    process.platform === 'win32'
                        ? await HostWindowsBuild.verifiedExecutable()
                        : undefined,
            });
            return fixture;
        } catch (caught: unknown) {
            await fixture[Symbol.asyncDispose]();
            throw caught;
        }
    }

    /** A revocation takes effect at the next operation, including output and stdin. */
    public authorize(access: HostWorkspaceAccess): Promise<void> {
        this.checks.push(access);
        if (!this.allowed) {
            throw new Error('Host grant revoked');
        }
        return Promise.resolve();
    }

    /** Fixture access requires successful runtime construction. */
    public get host(): HostWorkspace {
        if (this.workspace === null) {
            throw new Error('Fixture runtime unavailable');
        }
        return this.workspace;
    }

    /** Cleanup never retains test-created programs, output or directories. */
    public async [Symbol.asyncDispose](): Promise<void> {
        try {
            await this.workspace?.[Symbol.asyncDispose]();
        } finally {
            await rm(this.directory, { recursive: true, force: true });
        }
    }
}
