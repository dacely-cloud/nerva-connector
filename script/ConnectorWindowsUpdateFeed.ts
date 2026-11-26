// SPDX-FileCopyrightText: 2026 Dacely <business@dacely.com>
// SPDX-License-Identifier: LicenseRef-Proprietary

import { createHash, createPublicKey, sign, type KeyObject } from 'node:crypto';
import { copyFile, readFile } from 'node:fs/promises';
import { basename, join } from 'node:path';
import { ConnectorBuildArtifact } from './ConnectorBuildArtifact.ts';

/** One setup program the feed offers, by architecture. */
export interface ConnectorWindowsUpdateSetup {
    readonly architecture: 'x64' | 'arm64';
    readonly path: string;
}

/** The committed update configuration: where copies look and the release key's public half. */
export interface ConnectorWindowsUpdateConfiguration {
    readonly feedUrl: string;
    readonly publicKey: string;
}

/**
 * Writes and signs the Windows update feed that native/windows/installer/UpdateFeed.cs reads.
 *
 * @remarks
 * latest.json names the version and, per architecture, the setup program's file name, size and SHA-256.
 * latest.json.sig is the base64 RSA PKCS#1 v1.5 SHA-256 signature of latest.json's exact bytes, made with the
 * release key. Installed copies carry the public half, from assets/windows/updates.json, and accept nothing the key
 * did not sign. Keys shorter than 3072 bits are refused on both sides.
 *
 * latest.json is one line with no line break, so a checkout or upload that converts line endings cannot change the
 * signed bytes. Installed copies trim whitespace around the signature, so its trailing newline may be converted.
 */
export class ConnectorWindowsUpdateFeed {
    /** The committed configuration file. */
    public static readonly configuration: string = 'assets/windows/updates.json';
    static readonly #minimumBits: number = 3072;

    /** Reads the committed configuration, or `null` when updates are not configured. */
    public static async read(path: string): Promise<ConnectorWindowsUpdateConfiguration | null> {
        let raw: string;
        try {
            raw = await readFile(path, 'utf8');
        } catch (caught: unknown) {
            if (caught instanceof Error && 'code' in caught && caught.code === 'ENOENT') {
                return null;
            }
            throw caught;
        }
        const value: unknown = JSON.parse(raw);
        const feedUrl: unknown =
            typeof value === 'object' && value !== null ? Reflect.get(value, 'feedUrl') : null;
        const publicKey: unknown =
            typeof value === 'object' && value !== null ? Reflect.get(value, 'publicKey') : null;
        if (typeof feedUrl !== 'string' || typeof publicKey !== 'string') {
            throw new Error(path + ' needs feedUrl and publicKey');
        }
        this.publicKeyXml(publicKey);
        return { feedUrl, publicKey };
    }

    /**
     * Converts an RSA public key to the XML form .NET Framework imports.
     *
     * @param pem - The public key in PEM
     * @throws Error if it is not an RSA key of at least 3072 bits
     */
    public static publicKeyXml(pem: string): string {
        const key: KeyObject = createPublicKey(pem);
        const bits: number | undefined = key.asymmetricKeyDetails?.modulusLength;
        if (key.asymmetricKeyType !== 'rsa' || bits === undefined || bits < this.#minimumBits) {
            throw new Error('The update key must be an RSA key of at least 3072 bits');
        }
        const jwk: ReturnType<KeyObject['export']> = key.export({ format: 'jwk' });
        if (typeof jwk.n !== 'string' || typeof jwk.e !== 'string') {
            throw new Error('The update key has no RSA modulus or exponent');
        }
        return (
            '<RSAKeyValue><Modulus>' +
            Buffer.from(jwk.n, 'base64url').toString('base64') +
            '</Modulus><Exponent>' +
            Buffer.from(jwk.e, 'base64url').toString('base64') +
            '</Exponent></RSAKeyValue>'
        );
    }

    /**
     * Writes latest.json, its signature and a copy of every setup program into `directory`, ready to upload.
     *
     * @param directory - The output directory
     * @param version - The version every setup program installs
     * @param setups - The setup programs, one per architecture
     * @param privateKey - The release key in PEM
     */
    public static async write(
        directory: string,
        version: string,
        setups: readonly ConnectorWindowsUpdateSetup[],
        privateKey: string,
    ): Promise<void> {
        const files: Record<string, { name: string; size: string; sha256: string }> = {};
        for (const setup of setups) {
            const bytes: Buffer = await readFile(setup.path);
            const name: string = basename(setup.path);
            if (name !== `Nerva-Connector-Setup-${version}-${setup.architecture}.exe`) {
                throw new Error(name + ' does not match version ' + version);
            }
            files[setup.architecture] = {
                name,
                size: bytes.byteLength.toString(),
                sha256: createHash('sha256').update(bytes).digest('hex'),
            };
            await copyFile(setup.path, join(directory, name));
        }
        const latest: Buffer = Buffer.from(
            JSON.stringify({ product: 'nerva-connector-windows', version, files }),
        );
        const signature: string = sign('sha256', latest, privateKey).toString('base64');
        await ConnectorBuildArtifact.publish(join(directory, 'latest.json'), latest, 0o644);
        await ConnectorBuildArtifact.publish(
            join(directory, 'latest.json.sig'),
            signature + '\n',
            0o644,
        );
    }
}
