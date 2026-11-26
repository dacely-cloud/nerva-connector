// SPDX-FileCopyrightText: 2026 Dacely <business@dacely.com>
// SPDX-License-Identifier: LicenseRef-Proprietary

import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { ConnectorLinuxInstaller } from '../../script/ConnectorLinuxInstaller.js';
import { ConnectorPosixArchitecture } from '../../script/ConnectorPosixPlatform.js';

/** Small real shell-installation fixtures isolate HOME, shortcuts, programs and saved account data. */
export class ConnectorLinuxInstallerFixture implements AsyncDisposable {
    /** Every test owns exactly one removable directory under protected home ancestry. */
    public constructor(public readonly directory: string) {}

    /** Creates only the finite staged product files, using the real Node runtime through a tiny test launcher. */
    public static async create(): Promise<ConnectorLinuxInstallerFixture> {
        const fixture: ConnectorLinuxInstallerFixture = new ConnectorLinuxInstallerFixture(
            await mkdtemp(join(homedir(), 'nerva-linux-installer-')),
        );
        try {
            await mkdir(fixture.application, { mode: 0o700 });
            for (const file of ConnectorLinuxInstaller.files) {
                await writeFile(join(fixture.application, file), file + '\n', { mode: 0o600 });
            }
            await writeFile(
                join(fixture.application, 'node'),
                '#!/bin/sh\nexec ' +
                    "'" +
                    process.execPath.replaceAll("'", "'\\''") +
                    "'" +
                    ' "$@"\n',
                { mode: 0o700 },
            );
            await writeFile(
                join(fixture.application, '.nerva-installation'),
                'nerva-connector-linux-v1\n',
            );
            await writeFile(
                join(fixture.application, 'nerva-connector.mjs'),
                'process.stdout.write(JSON.stringify(process.argv.slice(2)));\n',
            );
            await writeFile(
                join(fixture.application, 'nerva-connector-update.mjs'),
                'process.argv.splice(2, 0, "connector"); await import("./nerva-connector.mjs");\n',
            );
            const launcher: Buffer = await readFile(
                new URL('../../assets/posix/nerva-connector', import.meta.url),
            );
            await writeFile(join(fixture.application, 'nerva-connector'), launcher, {
                mode: 0o700,
            });
            await fixture.build();
            return fixture;
        } catch (caught: unknown) {
            await fixture[Symbol.asyncDispose]();
            throw caught;
        }
    }

    /** Staging never shares a directory with the generated installer. */
    public get application(): string {
        return join(this.directory, 'app');
    }

    /** The single generated installer is overwritten atomically during upgrade tests. */
    public get installer(): string {
        return join(this.directory, 'Setup.run');
    }

    /** Uses the same tar, payload validation and script generator as a production package. */
    public async build(
        architecture: ConnectorPosixArchitecture = process.arch === 'arm64'
            ? ConnectorPosixArchitecture.Arm64
            : ConnectorPosixArchitecture.X64,
    ): Promise<void> {
        await ConnectorLinuxInstaller.build(
            this.application,
            this.installer,
            architecture,
            new AbortController().signal,
        );
    }

    /** Removes only this fixture's files on success and failure. */
    public async [Symbol.asyncDispose](): Promise<void> {
        await rm(this.directory, { recursive: true, force: true });
    }
}
