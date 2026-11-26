// SPDX-FileCopyrightText: 2026 Dacely <business@dacely.com>
// SPDX-License-Identifier: LicenseRef-Proprietary

import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { promisify } from 'node:util';
import { gzip } from 'node:zlib';
import { ConnectorBuildArtifact } from './ConnectorBuildArtifact.ts';

/** One file the Windows setup program installs, under its plain installed name. */
export interface ConnectorWindowsPayloadFile {
    /** The installed file name; letters, digits, spaces, dots, hyphens and underscores only. */
    readonly name: string;
    /** Where the build reads it from. */
    readonly source: string;
}

/**
 * Writes the payload the Windows setup program embeds and native/windows/installer/InstallerPayload.cs reads.
 *
 * @remarks
 * Layout, little-endian: the eight ASCII bytes NERVACP1, a UInt16-prefixed UTF-8 version, a UInt16 file count, then
 * per file a UInt16-prefixed UTF-8 name, its UInt64 size, its 32-byte SHA-256, a UInt64 compressed length and that
 * many gzip bytes. Setup checks every file's size and SHA-256 after decompressing it, before anything replaces an
 * earlier installation.
 */
export class ConnectorWindowsPayload {
    static readonly #magic: string = 'NERVACP1';

    /**
     * Compresses the files and publishes the payload atomically.
     *
     * @param destination - The payload file to write
     * @param version - The version setup records in Settings, Apps
     * @param files - The installed files, in install order
     * @returns The total uncompressed size in bytes
     */
    public static async write(
        destination: string,
        version: string,
        files: readonly ConnectorWindowsPayloadFile[],
    ): Promise<number> {
        if (files.length < 1 || files.length > 64) {
            throw new Error('A Windows payload carries between 1 and 64 files');
        }
        const names: Set<string> = new Set();
        const parts: Buffer[] = [Buffer.from(this.#magic, 'ascii'), this.#text(version, 64)];
        const count: Buffer = Buffer.alloc(2);
        count.writeUInt16LE(files.length, 0);
        parts.push(count);
        let total: number = 0;
        for (const file of files) {
            if (
                !/^[A-Za-z0-9 ._-]{1,128}$/u.test(file.name) ||
                file.name === '.' ||
                file.name === '..' ||
                names.has(file.name.toLowerCase())
            ) {
                throw new Error('Windows payload file names must be distinct plain file names');
            }
            names.add(file.name.toLowerCase());
            const bytes: Buffer = await readFile(file.source);
            const compressed: Buffer = await promisify(gzip)(bytes, { level: 9 });
            const sizes: Buffer = Buffer.alloc(8);
            sizes.writeBigUInt64LE(BigInt(bytes.byteLength), 0);
            const length: Buffer = Buffer.alloc(8);
            length.writeBigUInt64LE(BigInt(compressed.byteLength), 0);
            parts.push(
                this.#text(file.name, 128),
                sizes,
                createHash('sha256').update(bytes).digest(),
                length,
                compressed,
            );
            total += bytes.byteLength;
        }
        await ConnectorBuildArtifact.publish(destination, Buffer.concat(parts), 0o600);
        return total;
    }

    static #text(value: string, maximum: number): Buffer {
        const bytes: Buffer = Buffer.from(value, 'utf8');
        if (bytes.byteLength < 1 || bytes.byteLength > maximum) {
            throw new Error('Windows payload text is empty or too long');
        }
        const length: Buffer = Buffer.alloc(2);
        length.writeUInt16LE(bytes.byteLength, 0);
        return Buffer.concat([length, bytes]);
    }
}
