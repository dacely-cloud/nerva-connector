// SPDX-FileCopyrightText: 2026 Nerva contributors
// SPDX-License-Identifier: LicenseRef-Proprietary

import { readFile } from 'node:fs/promises';
import { expect, it } from 'vitest';
import { ConnectorBuildNotices } from '../script/ConnectorBuildNotices.js';

it('LF and Windows CRLF checkouts embed identical reviewed notices for the same dependency graph', async (): Promise<void> => {
    const [noticeText, lockText]: readonly [string, string] = await Promise.all([
        readFile('native/THIRD-PARTY-NOTICES.txt', 'utf8'),
        readFile('native/Cargo.lock', 'utf8'),
    ]);
    const notices: Buffer = Buffer.from(noticeText.replaceAll('\r\n', '\n'));
    const lock: Buffer = Buffer.from(lockText.replaceAll('\r\n', '\n'));
    const expected: string = ConnectorBuildNotices.prepare(
        notices,
        lock,
        'x86_64-unknown-linux-gnu',
    );
    for (const rawNotice of [
        notices,
        Buffer.from(notices.toString('utf8').replaceAll('\n', '\r\n')),
    ]) {
        for (const rawLock of [lock, Buffer.from(lock.toString('utf8').replaceAll('\n', '\r\n'))]) {
            expect(
                ConnectorBuildNotices.prepare(rawNotice, rawLock, 'x86_64-unknown-linux-gnu'),
            ).toBe(expected);
        }
    }
});

it('newline normalization cannot conceal changed dependencies, invalid encoding, comment injection or a wrong native target', async (): Promise<void> => {
    const [notices, lock]: readonly [Buffer, Buffer] = await Promise.all([
        readFile('native/THIRD-PARTY-NOTICES.txt'),
        readFile('native/Cargo.lock'),
    ]);
    expect((): void => {
        ConnectorBuildNotices.prepare(
            notices,
            Buffer.concat([lock, Buffer.from('\nchanged')]),
            'x86_64-unknown-linux-gnu',
        );
    }).toThrow('do not match native/Cargo.lock');
    expect((): void => {
        ConnectorBuildNotices.prepare(notices, lock, 'aarch64-apple-darwin');
    }).toThrow('do not match the target');
    expect((): void => {
        ConnectorBuildNotices.prepare(
            Buffer.concat([notices, Buffer.from('*/')]),
            lock,
            'x86_64-unknown-linux-gnu',
        );
    }).toThrow('malformed');
    expect((): void => {
        ConnectorBuildNotices.prepare(Buffer.from([255]), lock, 'x86_64-unknown-linux-gnu');
    }).toThrow();
    expect((): void => {
        ConnectorBuildNotices.prepare(
            notices,
            Buffer.concat([lock, Buffer.from('\r')]),
            'x86_64-unknown-linux-gnu',
        );
    }).toThrow('malformed');
});

it('both Linux and Mac architectures have reviewed notices for their own helper dependency graph', async (): Promise<void> => {
    const lock: Buffer = await readFile('native/Cargo.lock');
    for (const [platform, architecture, target] of [
        ['linux', 'x64', 'x86_64-unknown-linux-gnu'],
        ['linux', 'arm64', 'aarch64-unknown-linux-gnu'],
        ['win32', 'x64', 'x86_64-unknown-linux-gnu'],
        ['darwin', 'arm64', 'aarch64-apple-darwin'],
        ['darwin', 'x64', 'x86_64-apple-darwin'],
    ] as const) {
        expect(ConnectorBuildNotices.target(platform, architecture)).toBe(target);
        const notices: string = ConnectorBuildNotices.prepare(
            await readFile('native/' + ConnectorBuildNotices.file(target)),
            lock,
            target,
        );
        expect(notices.includes('seccompiler')).toBe(platform !== 'darwin');
    }
    expect((): string => ConnectorBuildNotices.target('linux', 'ia32')).toThrow('x64 or arm64');
});
