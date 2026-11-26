// SPDX-FileCopyrightText: 2026 Dacely <business@dacely.com>
// SPDX-License-Identifier: LicenseRef-Proprietary

import { mkdtemp, writeFile, rm, chmod } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { expect, it } from 'vitest';
import {
    JointWorkspaceConfiguration,
    type JointWorkspaceLocalConfiguration,
} from '../src/workspace/JointWorkspaceConfiguration.js';

it('derives only the fixed protected sibling mapping, setup intent and journal directory without changing device configuration', (): void => {
    const key: string = join(homedir(), 'connector-private', 'device-key.json');
    expect(JointWorkspaceConfiguration.paths(key)).toEqual({
        configurationFile: join(homedir(), 'connector-private', 'workspace-bindings.json'),
        stateDirectory: join(homedir(), 'connector-private', 'workspace-bindings'),
        setupFile: join(homedir(), 'connector-private', 'workspace-bindings-setup.json'),
    });
    expect((): void => {
        JointWorkspaceConfiguration.paths('/noncanonical/../device-key.json');
    }).toThrow('Canonical');
});

it('allows only explicit closed nonempty unique root pairs and detaches their immutable representation', (): void => {
    const pair: JointWorkspaceLocalConfiguration = {
        roots: [{ fileRootId: 'files', executionRootId: 'commands' }],
    };
    const current: JointWorkspaceLocalConfiguration = JointWorkspaceConfiguration.value(pair);
    expect(Object.isFrozen(current.roots[0])).toBe(true);
    Reflect.set(pair.roots[0] ?? pair, 'fileRootId', 'changed');
    expect(current.roots[0]?.fileRootId).toBe('files');
    for (const invalid of [
        { roots: [] },
        { roots: [{ fileRootId: 'files' }] },
        { roots: [{ fileRootId: '/host/path', executionRootId: 'commands' }] },
        { roots: current.roots, fallback: true },
        { roots: [...current.roots, ...current.roots] },
    ]) {
        expect((): JointWorkspaceLocalConfiguration =>
            JointWorkspaceConfiguration.value(invalid),
        ).toThrow();
    }
    const maximum: JointWorkspaceLocalConfiguration = {
        roots: Array.from(new Array<number>(128).fill(0), (_value: number, index: number) => ({
            fileRootId: 'files-' + index.toString(),
            executionRootId: 'commands-' + index.toString(),
        })),
    };
    expect(JointWorkspaceConfiguration.value(maximum).roots).toHaveLength(128);
    expect((): JointWorkspaceLocalConfiguration =>
        JointWorkspaceConfiguration.value({
            roots: [...maximum.roots, { fileRootId: 'last', executionRootId: 'last' }],
        }),
    ).toThrow();
});

it('treats only a missing fixed optional file as uninstalled; malformed or unprotected existing files fail closed', async (): Promise<void> => {
    const directory: string = await mkdtemp(join(homedir(), '.nerva-workspace-config-'));
    try {
        const key: string = join(directory, 'device-key.json');
        const path: string = JointWorkspaceConfiguration.paths(key).configurationFile;
        expect(await JointWorkspaceConfiguration.read(key)).toBeNull();
        const valid: JointWorkspaceLocalConfiguration = {
            roots: [{ fileRootId: 'files', executionRootId: 'commands' }],
        };
        await writeFile(path, JointWorkspaceConfiguration.encode(valid), { mode: 0o600 });
        expect(await JointWorkspaceConfiguration.read(key)).toEqual(valid);
        await writeFile(path, '{"roots":[],"fallback":true}', { mode: 0o600 });
        await expect(JointWorkspaceConfiguration.read(key)).rejects.toThrow();
        await writeFile(path, JointWorkspaceConfiguration.encode(valid));
        await chmod(path, 0o644);
        await expect(JointWorkspaceConfiguration.read(key)).rejects.toThrow('ownership');
    } finally {
        await rm(directory, { recursive: true, force: true });
    }
});
