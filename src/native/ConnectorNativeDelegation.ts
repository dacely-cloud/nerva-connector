// SPDX-FileCopyrightText: 2026 Nerva contributors
// SPDX-License-Identifier: LicenseRef-Proprietary

import { mkdir, writeFile, statfs, opendir } from 'node:fs/promises';
import type { Dir } from 'node:fs';
import { ProtectedFiles } from '../local/ProtectedFiles.js';
import type { ConnectorNativeLayout } from './ConnectorNativeTypes.js';

/** Only the actual registered system-service main process may restore its own delegated job subtree. */
export class ConnectorNativeDelegation {
    /** No attributes of unrelated systemd units or the hierarchy root are changed. */
    public static async restore(layout: ConnectorNativeLayout): Promise<void> {
        if (process.getuid?.() !== 0) {
            throw new Error('Root-owned native service required');
        }
        const membership: string = new TextDecoder('utf-8', { fatal: true }).decode(
            await ProtectedFiles.readTrusted(
                '/proc/' + String(process.pid) + '/cgroup',
                4096,
                false,
            ),
        );
        if (membership !== '0::/system.slice/' + layout.unitName + '/supervisor\n') {
            throw new Error('Native restoration requires the original service supervisor cgroup');
        }
        await ProtectedFiles.directory(layout.cgroupDirectory);
        if ((await statfs(layout.cgroupDirectory, { bigint: true })).type !== 0x63677270n) {
            throw new Error('Real delegated cgroup v2 required');
        }
        await this.#enable(layout.cgroupDirectory);
        try {
            await mkdir(layout.jobsDirectory);
        } catch (caught: unknown) {
            if (!(caught instanceof Error) || !('code' in caught) || caught.code !== 'EEXIST') {
                throw caught;
            }
        }
        await ProtectedFiles.directory(layout.jobsDirectory);
        const processes: string = (
            await ProtectedFiles.readTrusted(layout.jobsDirectory + '/cgroup.procs', 4096, false)
        ).toString('utf8');
        if (processes !== '') {
            throw new Error('Native job parent contains foreign processes');
        }
        await this.#enable(layout.jobsDirectory);
        const directory: Dir = await opendir(layout.jobsDirectory, { bufferSize: 32 });
        let entries: number = 0;
        for await (const entry of directory) {
            if (
                ++entries > 256 ||
                (entry.isDirectory() && !/^exec-[a-f0-9]{64}$/u.test(entry.name))
            ) {
                throw new Error('Unexpected delegated native job inventory');
            }
        }
    }
    static async #enable(directory: string): Promise<void> {
        const available: string = (
            await ProtectedFiles.readTrusted(directory + '/cgroup.controllers', 4096, false)
        ).toString('utf8');
        if (
            ['cpu', 'memory', 'pids'].some(
                (name): boolean => !available.trim().split(/\s+/u).includes(name),
            )
        ) {
            throw new Error('Required native controllers were not delegated');
        }
        await writeFile(directory + '/cgroup.subtree_control', '+cpu +memory +pids');
        const actual: string = (
            await ProtectedFiles.readTrusted(directory + '/cgroup.subtree_control', 4096, false)
        ).toString('utf8');
        if (
            ['cpu', 'memory', 'pids'].some(
                (name): boolean => !actual.trim().split(/\s+/u).includes(name),
            )
        ) {
            throw new Error('Native controllers were not enabled');
        }
    }
}
