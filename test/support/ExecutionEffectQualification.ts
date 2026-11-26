// SPDX-FileCopyrightText: 2026 Dacely <business@dacely.com>
// SPDX-License-Identifier: LicenseRef-Proprietary

import { lstat, realpath, readdir, readFile } from 'node:fs/promises';
import type { BigIntStats } from 'node:fs';
import { resolve } from 'node:path';
import { Boundary } from 'nerva-connector-protocol/protocol/Boundary.js';
import { ProtectedFiles } from '../../src/local/ProtectedFiles.js';
import { ExecutionEffectQualificationState } from './ExecutionEffectQualificationState.js';
import { ExecutionEffectQualificationCases } from './ExecutionEffectQualificationCases.js';
import {
    ExecutionEffectCase,
    requireEffect,
    type ExecutionEffectSettings,
    type ExecutionEffectReport,
    type ExecutionEffectCleanup,
} from './ExecutionEffectQualificationTypes.js';

/** Only the controller's explicit owned finite fixture and verified artifacts enter this local probe. */
async function settings(): Promise<ExecutionEffectSettings> {
    requireEffect(process.argv.length === 2 && process.getuid?.() === 0);
    const chunks: Buffer[] = [];
    let size: number = 0;
    const deadline: NodeJS.Timeout = setTimeout((): void => {
        process.stdin.destroy(new Error('Qualification input deadline'));
    }, 3000);
    try {
        for await (const part of process.stdin) {
            const chunk: unknown = part;
            requireEffect(Buffer.isBuffer(chunk));
            if (!Buffer.isBuffer(chunk)) {
                throw new Error('Invalid qualification input');
            }
            size += chunk.byteLength;
            requireEffect(size <= 24576);
            chunks.push(chunk);
        }
    } finally {
        clearTimeout(deadline);
    }
    const raw: unknown = JSON.parse(
        new TextDecoder('utf-8', { fatal: true }).decode(Buffer.concat(chunks, size)),
    );
    const value: Readonly<Record<string, unknown>> = Boundary.record(raw, [
        'directory',
        'helper',
        'probe',
        'delegation',
        'runtimeParent',
    ]);
    const paths: string[] = [];
    for (const name of ['directory', 'helper', 'probe', 'delegation', 'runtimeParent']) {
        const path: string = ProtectedFiles.path(value[name]);
        requireEffect(
            resolve(path) === path &&
                Buffer.byteLength(path) <= 4096 &&
                (await realpath(path)) === path,
        );
        paths.push(path);
    }
    const [directory, helper, probe, delegation, runtimeParent]: string[] = paths;
    if (
        directory === undefined ||
        helper === undefined ||
        probe === undefined ||
        delegation === undefined ||
        runtimeParent === undefined
    ) {
        throw new Error('Missing qualification path');
    }
    for (const parentPath of [directory, runtimeParent]) {
        await ProtectedFiles.directory(parentPath);
        const parent: BigIntStats = await lstat(parentPath, { bigint: true });
        requireEffect(
            parent.isDirectory() && parent.uid === 0n && (parent.mode & 0o777n) === 0o700n,
        );
    }
    requireEffect(directory !== runtimeParent && !runtimeParent.startsWith(directory + '/'));
    for (const path of [helper, probe]) {
        const info: BigIntStats = await lstat(path, { bigint: true });
        requireEffect(
            info.isFile() &&
                info.uid === 0n &&
                info.nlink >= 1n &&
                (info.mode & 0o022n) === 0n &&
                (info.mode & 0o111n) !== 0n,
        );
    }
    const group: BigIntStats = await lstat(delegation, { bigint: true });
    requireEffect(
        delegation.startsWith('/sys/fs/cgroup/') &&
            group.isDirectory() &&
            group.uid === 0n &&
            (group.mode & 0o022n) === 0n,
    );
    requireEffect((await readFile(delegation + '/cgroup.procs', 'utf8')) === '');
    for (const child of await readdir(delegation, { withFileTypes: true })) {
        requireEffect(!child.isDirectory());
    }
    return { directory, helper, probe, delegation, runtimeParent };
}

/** Files intentionally remain after all process/kernel owners and generated private keys are released. */
async function run(): Promise<ExecutionEffectReport> {
    let state: ExecutionEffectQualificationState | null = null;
    let current: ExecutionEffectCase = ExecutionEffectCase.Input;
    const cases: ExecutionEffectCase[] = [];
    let cohort: ExecutionEffectQualificationCases | null = null;
    let complete: boolean = false;
    let cleanup: ExecutionEffectCleanup = {
        keysReleased: false,
        kernelQuiescent: false,
        profilesRemoved: false,
        descriptorsReleased: false,
    };
    try {
        state = await ExecutionEffectQualificationState.create(await settings());
        cohort = new ExecutionEffectQualificationCases(state);
        for (const selected of Object.values(ExecutionEffectCase)) {
            if (selected === ExecutionEffectCase.Input) {
                continue;
            }
            current = selected;
            await cohort.run(selected);
            cases.push(selected);
        }
        complete = true;
    } catch {
        complete = false;
    } finally {
        if (state !== null) {
            try {
                cleanup = await state.release();
            } catch {
                complete = false;
            }
        }
    }
    const passed: boolean =
        complete &&
        cleanup.keysReleased &&
        cleanup.kernelQuiescent &&
        cleanup.profilesRemoved &&
        cleanup.descriptorsReleased;
    return {
        passed,
        trace: cohort?.trace ?? null,
        cases,
        failed: passed ? null : current,
        sourcesRetained: true,
        ...cleanup,
    };
}

const report: ExecutionEffectReport = await run();
process.stdout.write(JSON.stringify(report) + '\n');
process.exitCode = report.passed ? 0 : 1;
