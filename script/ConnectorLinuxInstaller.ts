// SPDX-FileCopyrightText: 2026 Nerva contributors
// SPDX-License-Identifier: LicenseRef-Proprietary

import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import { lstat, readFile, readdir, rm } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { promisify } from 'node:util';
import { ConnectorInstallerPaths } from '../src/install/ConnectorInstallerPaths.ts';
import { ConnectorBuildArtifact } from './ConnectorBuildArtifact.ts';
import type { ConnectorPosixArchitecture } from './ConnectorPosixPlatform.ts';
import { ConnectorUpdateFiles } from '../src/update/ConnectorUpdateFiles.ts';

/** Creates one offline, per-user Linux installer with a verified, closed set of program files. */
export class ConnectorLinuxInstaller {
    /** Only these deliberately staged product files enter the compressed payload. */
    public static readonly files: readonly string[] = ConnectorUpdateFiles.names('linux');

    /** Audits the entire staging directory before compression and removes its intermediate archive on every exit. */
    public static async build(
        application: string,
        destination: string,
        architecture: ConnectorPosixArchitecture,
        signal: AbortSignal,
    ): Promise<void> {
        const entries: readonly string[] = await readdir(application);
        if (
            entries.length !== this.files.length ||
            entries.some((name: string): boolean => !this.files.includes(name))
        ) {
            throw new Error('Linux payload contains missing or unexpected files');
        }
        let totalBytes: bigint = 0n;
        for (const name of this.files) {
            const status: Awaited<ReturnType<typeof lstat>> = await lstat(join(application, name));
            if (!status.isFile() || status.size === 0 || status.size > 268435456) {
                throw new Error('Linux payload requires bounded regular program files');
            }
            totalBytes += BigInt(status.size);
        }
        if (totalBytes > 402653184n) {
            throw new Error('Linux payload exceeds the installation byte limit');
        }
        const archive: string = destination + '.payload-' + process.pid.toString();
        try {
            await promisify(execFile)(
                'tar',
                ['-czf', archive, '-C', application, '--', ...this.files],
                {
                    timeout: 180000,
                    maxBuffer: 65536,
                    signal,
                },
            );
            if ((await lstat(archive)).size > 134217728) {
                throw new Error('Compressed Linux payload exceeds its byte limit');
            }
            const payload: Buffer = await readFile(archive);
            const template: string = await readFile(resolve('assets/linux/install.sh'), 'utf8');
            const header: string = template
                .replaceAll('@NERVA_MACHINE@', architecture === 'x64' ? 'x86_64' : 'aarch64|arm64')
                .replaceAll('@NERVA_ARCH@', architecture)
                .replaceAll('@NERVA_PATH_CHECKS@', ConnectorInstallerPaths.definitions().join('\n'))
                .replaceAll('@NERVA_FILES_CASE@', this.files.join('|'))
                .replaceAll('@NERVA_FILES_LINES@', this.files.join('\n'))
                .replaceAll('@NERVA_PAYLOAD_SIZE@', payload.byteLength.toString())
                .replaceAll(
                    '@NERVA_PAYLOAD_SHA256@',
                    createHash('sha256').update(payload).digest('hex'),
                );
            const terminated: string = header.endsWith('\n') ? header : header + '\n';
            const script: string = terminated.replaceAll(
                '@NERVA_PAYLOAD_LINE@',
                terminated.split('\n').length.toString(),
            );
            if (/@NERVA_[A-Z_]+@/u.test(script)) {
                throw new Error('Linux installer has unresolved build placeholders');
            }
            signal.throwIfAborted();
            await ConnectorBuildArtifact.publish(
                destination,
                Buffer.concat([Buffer.from(script), payload]),
                0o700,
            );
        } finally {
            await rm(archive, { force: true });
        }
    }
}
