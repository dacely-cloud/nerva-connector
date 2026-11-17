// SPDX-FileCopyrightText: 2026 Nerva contributors
// SPDX-License-Identifier: LicenseRef-Proprietary

import { generateKeyPairSync } from 'node:crypto';
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { expect, it, vi } from 'vitest';
import { ConnectorPosixUpdateBuild } from '../script/ConnectorPosixUpdateBuild.ts';
import { ConnectorPosixUpdateFeed } from '../script/ConnectorPosixUpdateFeed.ts';
import { ConnectorUpdateManifest } from '../src/update/ConnectorUpdateManifest.js';
import type { ConnectorUpdateSettings } from '../src/update/ConnectorUpdateProtocol.js';

/** Disposable publisher authority for feed round trips, independent of the actual product release key. */
interface TestPublisherKey {
    readonly publicKey: string;
    readonly privateKey: string;
}

it('publishes authenticated native feeds, prunes obsolete installers, and rejects a mismatched signing key before writing', async (): Promise<void> => {
    const directory: string = await mkdtemp(join(homedir(), 'nerva-feed-test-'));
    const key: TestPublisherKey = generateKeyPairSync('rsa', {
        modulusLength: 3072,
        publicKeyEncoding: { type: 'spki', format: 'pem' },
        privateKeyEncoding: { type: 'pkcs8', format: 'pem' },
    });
    vi.spyOn(ConnectorPosixUpdateBuild, 'configuration').mockResolvedValue({
        publicKey: key.publicKey,
        feeds: {
            linux: 'https://downloads.example.test/linux/',
            darwin: 'https://downloads.example.test/macos/',
        },
    });
    try {
        const source: string = join(directory, 'Nerva-Connector-Setup-1.2.0-x64.run');
        await writeFile(source, 'test signed native release', { mode: 0o600 });
        const output: string = join(directory, 'published');
        await mkdir(output, { mode: 0o700 });
        const old: string = 'Nerva-Connector-Setup-1.1.0-x64.run';
        await writeFile(join(output, old), 'obsolete');
        await writeFile(join(output, 'keep.txt'), 'unrelated');
        await ConnectorPosixUpdateFeed.write(
            output,
            'linux',
            '1.2.0',
            [{ architecture: 'x64', path: source }],
            key.privateKey,
        );
        const settings: ConnectorUpdateSettings = await ConnectorPosixUpdateBuild.settings(
            'linux',
            'x64',
            '1.1.0',
            'a'.repeat(64),
        );
        expect(
            ConnectorUpdateManifest.select(
                await readFile(join(output, 'latest.json')),
                await readFile(join(output, 'latest.json.sig'), 'utf8'),
                settings,
            )?.version,
        ).toBe('1.2.0');
        expect(await readFile(join(output, 'keep.txt'), 'utf8')).toBe('unrelated');
        expect(await readdir(output)).not.toContain(old);
        const wrong: TestPublisherKey = generateKeyPairSync('rsa', {
            modulusLength: 3072,
            publicKeyEncoding: { type: 'spki', format: 'pem' },
            privateKeyEncoding: { type: 'pkcs8', format: 'pem' },
        });
        const refused: string = join(directory, 'wrong-key');
        await expect(
            ConnectorPosixUpdateFeed.write(
                refused,
                'linux',
                '1.2.0',
                [{ architecture: 'x64', path: source }],
                wrong.privateKey,
            ),
        ).rejects.toThrow('does not match');
        expect(await readdir(directory)).not.toContain('wrong-key');
    } finally {
        vi.restoreAllMocks();
        await rm(directory, { recursive: true, force: true });
    }
});
