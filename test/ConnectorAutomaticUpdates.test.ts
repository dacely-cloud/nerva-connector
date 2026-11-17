// SPDX-FileCopyrightText: 2026 Nerva contributors
// SPDX-License-Identifier: LicenseRef-Proprietary

import { execFile } from 'node:child_process';
import { existsSync } from 'node:fs';
import { mkdir, readFile, readdir, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { promisify } from 'node:util';
import { describe, expect, it, vi, type MockInstance } from 'vitest';
import { ConnectorConnectionLog } from '../src/runtime/ConnectorConnectionLog.js';
import { ConnectorUpdateDownload } from '../src/update/ConnectorUpdateDownload.js';
import { ConnectorUpdateLock } from '../src/update/ConnectorUpdateLock.js';
import { ConnectorUpdatePackage } from '../src/update/ConnectorUpdatePackage.js';
import { ConnectorUpdateTransaction } from '../src/update/ConnectorUpdateTransaction.js';
import { ConnectorUpdateSupervisor } from '../src/update/ConnectorUpdateSupervisor.js';
import type { ConnectorUpdateRelease } from '../src/update/ConnectorUpdateProtocol.js';
import { ConnectorUpdateFixture } from './support/ConnectorUpdateFixture.js';

const native: boolean =
    (process.platform === 'linux' || process.platform === 'darwin') &&
    existsSync(resolve('build/nerva-connector-update'));

it('native update qualification cannot silently skip its helper', (): void => {
    if (process.env['NERVA_POSIX_UPDATE_SMOKE'] === '1') {
        expect(native).toBe(true);
    }
});

describe.skipIf(!native)('native automatic updates', (): void => {
    it('automatically restores the original directory if the installed launcher fails its post-swap probe', async (): Promise<void> => {
        await using fixture: ConnectorUpdateFixture = await ConnectorUpdateFixture.create();
        await fixture.transport();
        const release: ConnectorUpdateRelease = await fixture.release();
        await using transaction: ConnectorUpdateTransaction = new ConnectorUpdateTransaction(
            fixture.current,
            fixture.settings,
        );
        await transaction.prepare(release, new AbortController().signal);
        const smoke: MockInstance<typeof ConnectorUpdatePackage.smoke> = vi
            .spyOn(ConnectorUpdatePackage, 'smoke')
            .mockRejectedValueOnce(new Error('Fixture post-install launcher failure'));
        try {
            await expect(
                transaction.install(release, new AbortController().signal),
            ).rejects.toThrow('post-install launcher failure');
        } finally {
            smoke.mockRestore();
        }
        await ConnectorUpdatePackage.smoke(
            fixture.current,
            fixture.settings,
            '1.0.0',
            new AbortController().signal,
        );
    }, 60000);

    it('drains the real IPC console before replacement and starts the new console with the same installation', async (): Promise<void> => {
        await using fixture: ConnectorUpdateFixture = await ConnectorUpdateFixture.create(true);
        await fixture.transport();
        const receipt: string = join(fixture.directory, 'console-receipt');
        vi.stubEnv('NERVA_UPDATE_TEST_RECEIPT', receipt);
        const log: ConnectorConnectionLog = new ConnectorConnectionLog(
            join(fixture.directory, 'updater.log'),
        );
        await using transaction: ConnectorUpdateTransaction = new ConnectorUpdateTransaction(
            fixture.current,
            fixture.settings,
        );
        expect(
            await new ConnectorUpdateSupervisor(
                ConnectorUpdatePackage.program(fixture.current, fixture.settings.platform),
                fixture.settings,
                transaction,
                log,
            ).run(AbortSignal.timeout(30000)),
        ).toBe(true);
        expect(await readFile(receipt, 'utf8')).toBe('1.0.0:start\n1.0.0:stop\n');
        transaction.retainForRestart();
        await using next: ConnectorUpdateTransaction = new ConnectorUpdateTransaction(
            fixture.current,
            { ...fixture.settings, version: '1.1.0' },
        );
        await next.recover();
        expect(
            await new ConnectorUpdateSupervisor(
                ConnectorUpdatePackage.program(fixture.current, fixture.settings.platform),
                next.settings,
                next,
                log,
            ).run(AbortSignal.timeout(10000)),
        ).toBe(false);
        expect(await readFile(receipt, 'utf8')).toBe(
            '1.0.0:start\n1.0.0:stop\n1.1.0:start\n1.1.0:current\n',
        );
        await log.flush();
    }, 60000);

    it('stages and atomically installs a signed native update while preserving account data, then cleans crash leftovers', async (): Promise<void> => {
        await using fixture: ConnectorUpdateFixture = await ConnectorUpdateFixture.create();
        await fixture.transport();
        const state: string = join(fixture.directory, 'retained-account');
        await mkdir(state, { mode: 0o700 });
        const identity: Buffer = Buffer.from('identity, local grants and retained journal');
        await writeFile(join(state, 'device.json'), identity, { mode: 0o600 });
        const release: ConnectorUpdateRelease | null = await ConnectorUpdateDownload.check(
            fixture.settings,
            new AbortController().signal,
        );
        expect(release).not.toBeNull();
        if (release === null) {
            throw new Error('Missing signed fixture release');
        }
        await using transaction: ConnectorUpdateTransaction = new ConnectorUpdateTransaction(
            fixture.current,
            fixture.settings,
        );
        await transaction.prepare(release, new AbortController().signal);
        await ConnectorUpdatePackage.smoke(
            fixture.current,
            fixture.settings,
            '1.0.0',
            new AbortController().signal,
        );
        await transaction.install(release, new AbortController().signal);
        await ConnectorUpdatePackage.smoke(
            fixture.current,
            fixture.settings,
            '1.1.0',
            new AbortController().signal,
        );
        expect(await readFile(join(state, 'device.json'))).toEqual(identity);
        transaction.retainForRestart();
        await transaction[Symbol.asyncDispose]();
        const recovery: ConnectorUpdateTransaction = new ConnectorUpdateTransaction(
            fixture.current,
            { ...fixture.settings, version: '1.1.0' },
        );
        await recovery.recover();
        expect(
            (await readdir(fixture.directory)).some(
                (name: string): boolean =>
                    name.startsWith('.nerva-update-') || name.endsWith('.install-lock'),
            ),
        ).toBe(false);
    }, 60000);

    it('can restore the previous complete program before restart and rejects a second live supervisor', async (): Promise<void> => {
        await using fixture: ConnectorUpdateFixture = await ConnectorUpdateFixture.create();
        await fixture.transport();
        const release: ConnectorUpdateRelease = await fixture.release();
        await using transaction: ConnectorUpdateTransaction = new ConnectorUpdateTransaction(
            fixture.current,
            fixture.settings,
        );
        await transaction.prepare(release, new AbortController().signal);
        await transaction.install(release, new AbortController().signal);
        await transaction.rollback();
        await ConnectorUpdatePackage.smoke(
            fixture.current,
            fixture.settings,
            '1.0.0',
            new AbortController().signal,
        );
        const lockDirectory: string = join(fixture.directory, 'locks');
        await mkdir(lockDirectory, { mode: 0o700 });
        const helper: string = join(
            ConnectorUpdatePackage.program(fixture.current, fixture.settings.platform),
            'nerva-connector-update',
        );
        const file: string = join(lockDirectory, 'supervisor.lock');
        await using lock: ConnectorUpdateLock = await ConnectorUpdateLock.acquire(
            helper,
            file,
            fixture.settings,
        );
        await expect(ConnectorUpdateLock.acquire(helper, file, fixture.settings)).rejects.toThrow();
        await lock[Symbol.asyncDispose]();
        await using next: ConnectorUpdateLock = await ConnectorUpdateLock.acquire(
            helper,
            file,
            fixture.settings,
        );
        expect(next).toBeInstanceOf(ConnectorUpdateLock);
        expect(
            (
                await promisify(execFile)(
                    join(
                        ConnectorUpdatePackage.program(fixture.current, fixture.settings.platform),
                        'node',
                    ),
                    ['--version'],
                )
            ).stdout,
        ).toContain('v26.');
    }, 60000);
});
