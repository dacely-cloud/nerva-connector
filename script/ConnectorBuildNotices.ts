// SPDX-FileCopyrightText: 2026 Dacely <business@dacely.com>
// SPDX-License-Identifier: LicenseRef-Proprietary

import { createHash } from 'node:crypto';

/** Git checkout newline conversion cannot change the dependency graph commitment or reviewed license text. */
export class ConnectorBuildNotices {
    /**
     * The Rust target whose reviewed helper notices a build on this machine embeds.
     *
     * @remarks
     * macOS builds its own helper, whose dependency graph has no Linux-only crates. Linux and Windows
     * builds embed the Linux helper notices for the matching architecture.
     */
    public static target(platform: NodeJS.Platform, architecture: NodeJS.Architecture): string {
        const machine: string =
            architecture === 'x64' ? 'x86_64' : architecture === 'arm64' ? 'aarch64' : '';
        if (machine === '') {
            throw new Error('Native helper notices require an x64 or arm64 build');
        }
        return machine + (platform === 'darwin' ? '-apple-darwin' : '-unknown-linux-gnu');
    }

    /** The notice file for one target, relative to `native/`; Intel Linux keeps the original release name. */
    public static file(target: string): string {
        return target === 'x86_64-unknown-linux-gnu'
            ? 'THIRD-PARTY-NOTICES.txt'
            : 'THIRD-PARTY-NOTICES.' + target + '.txt';
    }

    /** Canonical LF text is checked before embedding; lock changes, malformed notices and wrong targets still fail. */
    public static prepare(noticeBytes: Uint8Array, lockBytes: Uint8Array, target: string): string {
        if (noticeBytes.byteLength > 131072 || lockBytes.byteLength > 1048576) {
            throw new Error('Native notice source exceeds its review bound');
        }
        const decoder: TextDecoder = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true });
        const notices: string = decoder.decode(noticeBytes).replaceAll('\r\n', '\n');
        const lock: string = decoder.decode(lockBytes).replaceAll('\r\n', '\n');
        if (
            notices.includes('*/') ||
            notices.includes('\r') ||
            lock.includes('\r') ||
            Buffer.byteLength(notices) > 65536
        ) {
            throw new Error('Native helper notices are malformed or exceed their review bound');
        }
        const header: readonly string[] = notices.split('\n', 4);
        const digest: string = createHash('sha256').update(lock, 'utf8').digest('hex');
        if (
            header[0] !== 'Native helper third-party notices' ||
            header[1] !== 'Cargo.lock SHA-256: ' + digest
        ) {
            throw new Error(
                'Native helper notices do not match native/Cargo.lock; review and regenerate the notices',
            );
        }
        if (header[2] !== 'Target: ' + target) {
            throw new Error(
                'Native helper notices do not match the target; review and regenerate them for ' +
                    target,
            );
        }
        return notices;
    }
}
