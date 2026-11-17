// SPDX-FileCopyrightText: 2026 Nerva contributors
// SPDX-License-Identifier: LicenseRef-Proprietary

import { createHash, generateKeyPairSync, sign } from 'node:crypto';
import { expect, it } from 'vitest';
import { ConnectorUpdateManifest } from '../src/update/ConnectorUpdateManifest.js';
import {
    ConnectorUpdateMessage,
    ConnectorUpdateStatus,
} from '../src/update/ConnectorUpdateMessage.js';
import type {
    ConnectorUpdateRelease,
    ConnectorUpdateSettings,
} from '../src/update/ConnectorUpdateProtocol.js';

/** Isolated authority for signed-feed boundary checks. */
interface TestUpdateKey {
    readonly publicKey: string;
    readonly privateKey: string;
}
const key: TestUpdateKey = generateKeyPairSync('rsa', {
    modulusLength: 3072,
    publicKeyEncoding: { type: 'spki', format: 'pem' },
    privateKeyEncoding: { type: 'pkcs8', format: 'pem' },
});
const settings: ConnectorUpdateSettings = {
    version: '1.9.0',
    platform: 'linux',
    architecture: 'x64',
    feedUrl: 'https://downloads.example.test/linux/',
    publicKey: key.publicKey,
    helperSha256: 'a'.repeat(64),
    files: [],
};

it('authenticates exact bytes, targets the native platform and compares versions numerically', (): void => {
    const bytes: Buffer = Buffer.from(
        JSON.stringify({
            product: 'nerva-connector-linux',
            version: '1.10.0',
            files: {
                x64: {
                    name: 'Nerva-Connector-Setup-1.10.0-x64.run',
                    size: '12',
                    sha256: createHash('sha256').update('test release').digest('hex'),
                },
            },
        }),
    );
    const signature: string = sign('sha256', bytes, key.privateKey).toString('base64');
    expect(ConnectorUpdateManifest.select(bytes, signature, settings)?.version).toBe('1.10.0');
    expect(
        ConnectorUpdateManifest.select(bytes, signature, { ...settings, version: '1.10.0' }),
    ).toBeNull();
    expect(
        ConnectorUpdateManifest.select(bytes, signature, { ...settings, version: '2.0.0' }),
    ).toBeNull();
    expect(
        ConnectorUpdateManifest.select(bytes, signature, { ...settings, architecture: 'arm64' }),
    ).toBeNull();
    expect((): ConnectorUpdateRelease | null =>
        ConnectorUpdateManifest.select(
            Buffer.concat([bytes, Buffer.from(' ')]),
            signature,
            settings,
        ),
    ).toThrow('signature');
    expect((): ConnectorUpdateRelease | null =>
        ConnectorUpdateManifest.select(bytes, signature, { ...settings, platform: 'darwin' }),
    ).toThrow('another product');
    for (const invalid of ['01.2.3', '1.2', '1.2.3-beta', '9999999999.0.0']) {
        expect((): string => ConnectorUpdateManifest.version(invalid)).toThrow();
    }
});

it('rejects malformed signed paths, sizes, fields and unsigned feed locations', (): void => {
    for (const file of [
        { name: '../installer.run', size: '12', sha256: 'a'.repeat(64) },
        { name: 'Nerva-Connector-Setup-1.10.0-x64.run', size: '-1', sha256: 'a'.repeat(64) },
        { name: 'Nerva-Connector-Setup-1.10.0-x64.run', size: '134217729', sha256: 'a'.repeat(64) },
        { name: 'Nerva-Connector-Setup-1.10.0-x64.run', size: '12', sha256: 'invalid' },
    ]) {
        const bytes: Buffer = Buffer.from(
            JSON.stringify({
                product: 'nerva-connector-linux',
                version: '1.10.0',
                files: { x64: file },
            }),
        );
        expect((): ConnectorUpdateRelease | null =>
            ConnectorUpdateManifest.select(
                bytes,
                sign('sha256', bytes, key.privateKey).toString('base64'),
                settings,
            ),
        ).toThrow();
    }
    for (const url of [
        'http://downloads.example.test/',
        'https://user:password@downloads.example.test/',
        'https://downloads.example.test/?token=secret',
        'https://downloads.example.test/not-a-directory',
    ]) {
        expect((): URL => ConnectorUpdateManifest.directory(url)).toThrow();
    }
    expect(
        ConnectorUpdateMessage.read({ nervaConnectorUpdate: 'check', command: 'untrusted' }),
    ).toBeNull();
    expect(
        ConnectorUpdateMessage.read({ nervaConnectorUpdate: ConnectorUpdateStatus.Checking }),
    ).toBe(ConnectorUpdateStatus.Checking);
});
