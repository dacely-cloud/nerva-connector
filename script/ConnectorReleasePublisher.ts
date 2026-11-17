// SPDX-FileCopyrightText: 2026 Nerva contributors
// SPDX-License-Identifier: LicenseRef-Proprietary

import { open, rename, rm, type FileHandle } from 'node:fs/promises';
import type { ConnectorPrivateDirectory } from '../src/runtime/ConnectorPrivateDirectory.ts';

/** Generated public pins and launchers use the existing native owner rather than inherited Windows file permissions. */
export class ConnectorReleasePublisher {
    static readonly #names: ReadonlySet<string> = new Set([
        'release.json',
        'release-bootstrap.json',
        'install-connector.sh',
        'install-connector.cmd',
        'launcher.sh',
        'launcher.cjs',
        'nerva-connector-bootstrap.exe',
        'README.md',
        'package.json',
    ]);

    /** Existing leaves must already be valid private files; no permissions or unknown partials are adopted. */
    public static async write(
        owner: ConnectorPrivateDirectory,
        name: string,
        bytes: Buffer,
    ): Promise<void> {
        const maximum: number = name === 'nerva-connector-bootstrap.exe' ? 262144 : 131072;
        if (!this.#names.has(name) || bytes.length > maximum) {
            throw new Error('Invalid bounded release publisher output');
        }
        await owner.cleanPartial(name, maximum);
        const exists: boolean = await owner.exists(name);
        if (exists) {
            await owner.read(name, maximum);
        }
        if (process.platform === 'win32') {
            await owner.write(name, bytes, maximum, !exists);
            return;
        }
        const temporary: string = owner.file(name + '.partial');
        try {
            const file: FileHandle = await open(
                temporary,
                'wx',
                name.endsWith('.sh') || name.endsWith('.cjs') || name.endsWith('.exe')
                    ? 0o700
                    : 0o600,
            );
            try {
                await file.writeFile(bytes);
                await file.sync();
            } finally {
                await file.close();
            }
            await rename(temporary, owner.file(name));
        } finally {
            await rm(temporary, { force: true });
        }
    }
}
