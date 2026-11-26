// SPDX-FileCopyrightText: 2026 Dacely <business@dacely.com>
// SPDX-License-Identifier: LicenseRef-Proprietary

import { constants, createPublicKey, verify, type KeyObject } from 'node:crypto';
import {
    ConnectorUpdatePlatform,
    type ConnectorUpdateSettings,
    type ConnectorUpdateRelease,
    type ConnectorUpdateArtifact,
} from './ConnectorUpdateProtocol.ts';

/** Verifies the signature before parsing and rejects ambiguous versions, paths, products and numeric sizes. */
export class ConnectorUpdateManifest {
    /** The response bound applies before JSON decoding or signature work. */
    public static readonly maximumBytes: number = 32768;
    /** Installers are streamed and must match this signed bound exactly. */
    public static readonly maximumInstallerBytes: bigint = 134217728n;

    /** Only canonical numeric release versions participate in downgrade prevention. */
    public static version(value: unknown): string {
        if (
            typeof value !== 'string' ||
            !/^(0|[1-9][0-9]{0,8})\.(0|[1-9][0-9]{0,8})\.(0|[1-9][0-9]{0,8})$/u.test(value)
        ) {
            throw new Error('Update requires a canonical major.minor.patch version');
        }
        return value;
    }

    /** Release ordering uses exact integers and accepts only strictly newer versions. */
    public static newer(candidate: string, installed: string): boolean {
        const next: readonly bigint[] = this.version(candidate)
            .split('.')
            .map((part: string): bigint => BigInt(part));
        const previous: readonly bigint[] = this.version(installed)
            .split('.')
            .map((part: string): bigint => BigInt(part));
        for (let index: number = 0; index < 3; index++) {
            if (next[index] !== previous[index]) {
                return next[index] > previous[index];
            }
        }
        return false;
    }

    /** Update authority is a finite RSA public key of the same strength as Windows. */
    public static key(pem: string): KeyObject {
        if (pem.length > 16384) {
            throw new Error('Update public key exceeds its bound');
        }
        const key: KeyObject = createPublicKey(pem);
        const bits: number | undefined = key.asymmetricKeyDetails?.modulusLength;
        if (key.asymmetricKeyType !== 'rsa' || bits === undefined || bits < 3072 || bits > 8192) {
            throw new Error('Updates require an RSA release key between 3072 and 8192 bits');
        }
        return key;
    }

    /** HTTPS directories cannot carry credentials, queries, fragments or redirect-based trust changes. */
    public static directory(value: string): URL {
        if (value.length > 4096) {
            throw new Error('Update feed URL exceeds its bound');
        }
        const url: URL = new URL(value);
        if (
            url.protocol !== 'https:' ||
            url.username !== '' ||
            url.password !== '' ||
            url.search !== '' ||
            url.hash !== '' ||
            !url.pathname.endsWith('/')
        ) {
            throw new Error('Updates require a fixed HTTPS feed directory');
        }
        return url;
    }

    /** Signature and all catalog entries are checked even when no newer native release is offered. */
    public static select(
        bytes: Buffer,
        signatureText: string,
        settings: ConnectorUpdateSettings,
    ): ConnectorUpdateRelease | null {
        if (bytes.length > this.maximumBytes || signatureText.length > 4096) {
            throw new Error('Signed update manifest exceeds its bound');
        }
        const signature: string = signatureText.trim();
        const key: KeyObject = this.key(settings.publicKey);
        if (
            !/^[A-Za-z0-9+/]+={0,2}$/u.test(signature) ||
            !verify(
                'sha256',
                bytes,
                { key, padding: constants.RSA_PKCS1_PADDING },
                Buffer.from(signature, 'base64'),
            )
        ) {
            throw new Error('Update manifest signature is invalid');
        }
        const raw: unknown = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes));
        const record: Readonly<Record<string, unknown>> = this.record(raw, [
            'product',
            'version',
            'files',
        ]);
        const product: string =
            settings.platform === ConnectorUpdatePlatform.Linux
                ? 'nerva-connector-linux'
                : 'nerva-connector-macos';
        if (record['product'] !== product) {
            throw new Error('Update manifest targets another product');
        }
        const version: string = this.version(record['version']);
        const files: Readonly<Record<string, unknown>> = this.record(
            record['files'],
            ['x64', 'arm64'],
            false,
        );
        const artifacts: Map<string, ConnectorUpdateArtifact> = new Map();
        for (const [architecture, entry] of Object.entries(files)) {
            const file: Readonly<Record<string, unknown>> = this.record(entry, [
                'name',
                'size',
                'sha256',
            ]);
            const extension: string =
                settings.platform === ConnectorUpdatePlatform.Linux ? 'run' : 'dmg';
            const expected: string = `Nerva-Connector-Setup-${version}-${architecture}.${extension}`;
            if (
                file['name'] !== expected ||
                typeof file['size'] !== 'string' ||
                !/^[1-9][0-9]{0,8}$/u.test(file['size']) ||
                typeof file['sha256'] !== 'string' ||
                !/^[a-f0-9]{64}$/u.test(file['sha256'])
            ) {
                throw new Error('Update installer has an invalid name, size or digest');
            }
            const size: bigint = BigInt(file['size']);
            if (size > this.maximumInstallerBytes) {
                throw new Error('Update installer exceeds its byte limit');
            }
            artifacts.set(architecture, { name: expected, size, sha256: file['sha256'] });
        }
        const artifact: ConnectorUpdateArtifact | undefined = artifacts.get(settings.architecture);
        return artifact !== undefined && this.newer(version, settings.version)
            ? { version, artifact }
            : null;
    }

    /** Untrusted JSON records are validated before property access and never merged into application state. */
    public static record(
        raw: unknown,
        keys: readonly string[],
        required: boolean = true,
    ): Readonly<Record<string, unknown>> {
        if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) {
            throw new Error('Update requires a JSON record');
        }
        const actual: readonly string[] = Object.keys(raw);
        if (
            actual.length === 0 ||
            actual.some((key: string): boolean => !keys.includes(key)) ||
            (required && actual.length !== keys.length)
        ) {
            throw new Error('Update record contains missing or unsupported fields');
        }
        const record: Record<string, unknown> = {};
        for (const key of actual) {
            const value: unknown = Reflect.get(raw, key);
            record[key] = value;
        }
        return record;
    }
}
