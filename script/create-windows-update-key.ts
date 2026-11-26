// SPDX-FileCopyrightText: 2026 Dacely <business@dacely.com>
// SPDX-License-Identifier: LicenseRef-Proprietary

import { generateKeyPairSync } from 'node:crypto';
import { open, type FileHandle } from 'node:fs/promises';
import { isAbsolute, resolve } from 'node:path';
import { ConnectorBuildArtifact } from './ConnectorBuildArtifact.ts';
import { ConnectorWindowsUpdateFeed } from './ConnectorWindowsUpdateFeed.ts';

/**
 * Creates the Windows update signing key and points installed copies at an update feed.
 *
 * @remarks
 * Writes a new RSA-3072 private key to `--key`, readable only by its owner, and refuses to replace an existing file,
 * so a key that signed earlier releases is never lost. Keep that file off the repository and out of backups others
 * can read: whoever holds it can ship code to every installed connector. assets/windows/updates.json receives the
 * public key and the feed URL; commit it, then build the installer.
 *
 * Usage: `npm run create:windows-update-key -- --key /secure/path/update-key.pem --feed https://host/path/`
 */
const supplied: readonly string[] = process.argv.slice(2);
if (supplied.length !== 4 || supplied[0] !== '--key' || supplied[2] !== '--feed') {
    throw new Error(
        'Usage: create-windows-update-key --key <private-key.pem> --feed <https://host/path/>',
    );
}
const keyPath: string = supplied[1] ?? '';
const feedUrl: string = supplied[3] ?? '';
if (!isAbsolute(keyPath) || resolve(keyPath).startsWith(resolve('.') + '/')) {
    throw new Error('Keep the private key outside the repository, at an absolute path');
}
if (!/^https:\/\/[A-Za-z0-9.-]+(:[0-9]{1,5})?(\/[A-Za-z0-9._~-]+)*\/$/u.test(feedUrl)) {
    throw new Error('The feed URL must be https:// and end with a slash');
}
const pair: { publicKey: string; privateKey: string } = generateKeyPairSync('rsa', {
    modulusLength: 3072,
    publicKeyEncoding: { type: 'spki', format: 'pem' },
    privateKeyEncoding: { type: 'pkcs8', format: 'pem' },
});
const file: FileHandle = await open(keyPath, 'wx', 0o600);
try {
    await file.writeFile(pair.privateKey);
    await file.sync();
} finally {
    await file.close();
}
await ConnectorBuildArtifact.publish(
    resolve(ConnectorWindowsUpdateFeed.configuration),
    JSON.stringify({ feedUrl, publicKey: pair.publicKey }, null, 4) + '\n',
    0o644,
);
process.stdout.write(
    JSON.stringify({
        privateKey: keyPath,
        configuration: ConnectorWindowsUpdateFeed.configuration,
    }) + '\n',
);
