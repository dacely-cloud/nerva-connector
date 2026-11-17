// SPDX-FileCopyrightText: 2026 Nerva contributors
// SPDX-License-Identifier: LicenseRef-Proprietary

import { X509Certificate } from 'node:crypto';
import { Boundary } from 'nerva-connector-protocol/protocol/Boundary.js';
import { IdentityCodec } from 'nerva-connector-protocol/identity/IdentityCodec.js';
import { SigningKey } from '../identity/SigningKey.js';
import { SignaturePurpose } from 'nerva-connector-protocol/identity/IdentityFormat.js';
import { ConnectorConnectionConfiguration } from '../runtime/ConnectorConnectionConfiguration.js';
import { ConnectorReleaseLimits } from './ConnectorReleaseLimits.js';
import { ConnectorReleaseAssets } from './ConnectorReleaseAssets.js';
import {
    ConnectorReleaseProtocol,
    ConnectorReleaseArchitecture,
    ConnectorReleasePlatform,
    ConnectorReleaseFile,
    type ConnectorReleaseArtifact,
    type ConnectorReleaseDeployment,
    type ConnectorReleaseManifest,
    type ConnectorSignedRelease,
} from './ConnectorRelease.js';

/** A trusted release key is installed separately; no signature or gateway can select its own verification identity. */
export class ConnectorReleaseCodec {
    /** Byte bounds precede JSON parsing in callers; this codec enforces exact shape, fixed assets and finite validity. */
    public static read(raw: unknown, publicKey: string, nowMs: bigint): ConnectorSignedRelease {
        const envelope: Readonly<Record<string, unknown>> = Boundary.record(raw, [
            'manifest',
            'signature',
        ]);
        const value: Readonly<Record<string, unknown>> = Boundary.record(envelope['manifest'], [
            'protocol',
            'releaseId',
            'revision',
            'issuedAtMs',
            'expiresAtMs',
            'platform',
            'architecture',
            'artifacts',
            'deployment',
        ]);
        const architecture: ConnectorReleaseArchitecture | undefined = Object.values(
            ConnectorReleaseArchitecture,
        ).find((entry: ConnectorReleaseArchitecture): boolean => entry === value['architecture']);
        const platform: ConnectorReleasePlatform | undefined = Object.values(
            ConnectorReleasePlatform,
        ).find((entry: ConnectorReleasePlatform): boolean => entry === value['platform']);
        const issuedAtMs: bigint = Boundary.integer(value['issuedAtMs']);
        const expiresAtMs: bigint = Boundary.integer(value['expiresAtMs']);
        const revision: bigint = Boundary.integer(value['revision']);
        const artifacts: readonly ConnectorReleaseArtifact[] = Boundary.array(
            value['artifacts'],
            9,
        ).map((entry: unknown): ConnectorReleaseArtifact => this.#artifact(entry));
        if (
            value['protocol'] !== ConnectorReleaseProtocol.Current ||
            architecture === undefined ||
            platform === undefined ||
            revision === 0n ||
            nowMs < 0n ||
            issuedAtMs > nowMs ||
            expiresAtMs <= nowMs ||
            expiresAtMs <= issuedAtMs ||
            expiresAtMs - issuedAtMs > 7776000000n ||
            artifacts.length !== ConnectorReleaseAssets.names(platform).length ||
            ConnectorReleaseAssets.names(platform).some(
                (name: ConnectorReleaseFile, index: number): boolean =>
                    artifacts[index]?.name !== name,
            )
        ) {
            throw new Error('Invalid current connector release');
        }
        const manifest: ConnectorReleaseManifest = {
            protocol: ConnectorReleaseProtocol.Current,
            releaseId: Boundary.id(value['releaseId']),
            revision,
            issuedAtMs,
            expiresAtMs,
            platform,
            architecture,
            artifacts,
            deployment: this.#deployment(value['deployment']),
        };
        const signature: string = IdentityCodec.signature(envelope['signature']).toString(
            'base64url',
        );
        if (
            publicKey === manifest.deployment.publicKey ||
            !SigningKey.verify(
                SignaturePurpose.Release,
                publicKey,
                this.payload(manifest),
                signature,
            )
        ) {
            throw new Error(
                'Connector release requires its separate trusted dual-signature identity',
            );
        }
        return { manifest, signature };
    }
    /** Explicit property order and exact decimal quantities are shared by signer and installer. */
    public static payload(manifest: ConnectorReleaseManifest): Buffer {
        const canonical: ConnectorReleaseManifest = {
            protocol: manifest.protocol,
            releaseId: manifest.releaseId,
            revision: manifest.revision,
            issuedAtMs: manifest.issuedAtMs,
            expiresAtMs: manifest.expiresAtMs,
            platform: manifest.platform,
            architecture: manifest.architecture,
            artifacts: manifest.artifacts.map(
                (artifact: ConnectorReleaseArtifact): ConnectorReleaseArtifact => ({
                    name: artifact.name,
                    sizeBytes: artifact.sizeBytes,
                    sha256: artifact.sha256,
                }),
            ),
            deployment: {
                authorityId: manifest.deployment.authorityId,
                publicKey: manifest.deployment.publicKey,
                endpoints: manifest.deployment.endpoints,
                verificationUri: manifest.deployment.verificationUri,
                serverCaPem: manifest.deployment.serverCaPem,
            },
        };
        return Buffer.from(
            JSON.stringify(canonical, (_key: string, value: unknown): unknown =>
                typeof value === 'bigint' ? value.toString() : value,
            ),
        );
    }
    /** The retained signed release is also the installation intent; differing releases cannot overwrite an installation. */
    public static encode(value: ConnectorSignedRelease): Buffer {
        return Buffer.from(
            JSON.stringify(value, (_key: string, entry: unknown): unknown =>
                typeof entry === 'bigint' ? entry.toString() : entry,
            ),
        );
    }
    /** Artifact bounds also constrain streamed copy and download before execution. */
    public static maximum(name: ConnectorReleaseFile): number {
        if (
            name === ConnectorReleaseFile.WindowsStateMetadata ||
            name === ConnectorReleaseFile.WindowsHostMetadata
        ) {
            return 2048;
        }
        if (
            name === ConnectorReleaseFile.WindowsState ||
            name === ConnectorReleaseFile.WindowsHost
        ) {
            return 262144;
        }
        return name === ConnectorReleaseFile.Notices
            ? 65536
            : name === ConnectorReleaseFile.Runtime || name === ConnectorReleaseFile.WindowsRuntime
              ? 268435456
              : name === ConnectorReleaseFile.HostWorker
                ? 262144
                : name === ConnectorReleaseFile.Application
                  ? ConnectorReleaseLimits.applicationBytes
                  : 1048576;
    }
    /** Notices and licenses are verified data assets, never executable permissions. */
    public static executable(name: ConnectorReleaseFile): boolean {
        return ![
            ConnectorReleaseFile.License,
            ConnectorReleaseFile.Notices,
            ConnectorReleaseFile.WindowsStateMetadata,
            ConnectorReleaseFile.WindowsHostMetadata,
        ].includes(name);
    }
    static #artifact(raw: unknown): ConnectorReleaseArtifact {
        const value: Readonly<Record<string, unknown>> = Boundary.record(raw, [
            'name',
            'sizeBytes',
            'sha256',
        ]);
        const name: ConnectorReleaseFile | undefined = Object.values(ConnectorReleaseFile).find(
            (entry): boolean => entry === value['name'],
        );
        const sizeBytes: bigint = Boundary.integer(value['sizeBytes']);
        if (
            name === undefined ||
            sizeBytes === 0n ||
            sizeBytes > BigInt(this.maximum(name)) ||
            typeof value['sha256'] !== 'string' ||
            !/^[a-f0-9]{64}$/u.test(value['sha256'])
        ) {
            throw new Error('Invalid connector release artifact');
        }
        return { name, sizeBytes, sha256: value['sha256'] };
    }
    static #deployment(raw: unknown): ConnectorReleaseDeployment {
        const value: Readonly<Record<string, unknown>> = Boundary.record(raw, [
            'authorityId',
            'publicKey',
            'endpoints',
            'verificationUri',
            'serverCaPem',
        ]);
        const verificationUri: URL = new URL(Boundary.text(value['verificationUri']));
        if (
            verificationUri.protocol !== 'https:' ||
            verificationUri.username !== '' ||
            verificationUri.password !== '' ||
            verificationUri.search !== '' ||
            verificationUri.hash !== ''
        ) {
            throw new Error('Connector release requires its trusted HTTPS UI');
        }
        const pem: unknown = value['serverCaPem'];
        if (
            pem !== null &&
            (typeof pem !== 'string' ||
                Buffer.byteLength(pem) > 65536 ||
                new X509Certificate(pem).toString().trim() !== pem.trim())
        ) {
            throw new Error('Connector release requires one exact trusted certificate');
        }
        return {
            authorityId: Boundary.id(value['authorityId']),
            publicKey: IdentityCodec.publicKey(value['publicKey']).toString('base64url'),
            endpoints: ConnectorConnectionConfiguration.endpoints(value['endpoints']),
            verificationUri: verificationUri.href,
            serverCaPem: pem,
        };
    }
}
