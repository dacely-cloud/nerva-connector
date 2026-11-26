// SPDX-FileCopyrightText: 2026 Dacely <business@dacely.com>
// SPDX-License-Identifier: LicenseRef-Proprietary

import { createHash } from 'node:crypto';
import { execFile } from 'node:child_process';
import { existsSync } from 'node:fs';
import { promisify } from 'node:util';
import { expect, it } from 'vitest';
import {
    ExecutionAppArmorProfile,
    ExecutionAppArmorMode,
    type ExecutionAppArmorDefinition,
} from '../src/execution/ExecutionAppArmorProfile.js';
import { ExecutionWorkspaceAccess } from 'nerva-connector-protocol/execution/ExecutionTypes.js';
import { ExecutionMachineFixture } from './support/ExecutionMachineFixture.js';

it('foreground profile bytes retain their qualified identity and receive no guardian trace permission', (): void => {
    const profile: ExecutionAppArmorDefinition = ExecutionAppArmorProfile.generate(
        ExecutionMachineFixture.policy(),
    );
    expect(createHash('sha256').update(profile.source).digest('hex')).toBe(
        '98c942ac35ae95887907b982c3606e686cfbf3e51c8436f7284c0dfe70dd3c02',
    );
    expect(profile.guardianName).toBeNull();
    expect(profile.source).not.toContain('ptrace (read,trace)');
    expect(profile.source).not.toContain('tracedby');
});

it('only explicit Pipe profiles permit the named guardian to trace its matching confined child stack', (): void => {
    const profile: ExecutionAppArmorDefinition = ExecutionAppArmorProfile.generate(
        ExecutionMachineFixture.policy(),
        ExecutionAppArmorMode.Pipe,
    );
    if (profile.guardianName === null) {
        throw new Error('An explicit Pipe guardian is required');
    }
    const parent: string = [profile.guardianName, profile.launcherName].sort().join('//&');
    const child: string = [profile.name, profile.guardianName, profile.launcherName]
        .sort()
        .join('//&');
    expect(profile.source).toContain('ptrace (read,trace) peer="' + child + '",');
    expect(profile.source).toContain('ptrace (readby,tracedby) peer="' + parent + '",');
    expect(profile.source).toContain('change_profile -> &' + profile.guardianName + ',');
    expect(profile.source).not.toContain('@');
    expect(profile.source).not.toMatch(/ptrace[^\n]*peer=[^\n]*\*/u);
    expect(profile.source).not.toContain('  ptrace,');
    const readOnly: ExecutionAppArmorDefinition = ExecutionAppArmorProfile.generate(
        {
            ...ExecutionMachineFixture.policy(),
            roots: [
                { id: 'project', path: '/srv/project', access: ExecutionWorkspaceAccess.ReadOnly },
            ],
        },
        ExecutionAppArmorMode.Pipe,
    );
    expect(readOnly.source).not.toContain('/workspace/** rwk,');
    expect(profile.source).toContain('/workspace/** rwk,');
});

it.skipIf(process.platform !== 'linux' || !existsSync('/usr/sbin/apparmor_parser'))(
    'the real kernel policy parser accepts both modes without loading profiles or creating caches',
    async (): Promise<void> => {
        for (const mode of [ExecutionAppArmorMode.Foreground, ExecutionAppArmorMode.Pipe]) {
            const profile: ExecutionAppArmorDefinition = ExecutionAppArmorProfile.generate(
                ExecutionMachineFixture.policy(),
                mode,
            );
            const task: ReturnType<typeof execFile.__promisify__> = promisify(execFile)(
                '/usr/sbin/apparmor_parser',
                ['--skip-kernel-load', '--skip-cache', '--jobs', '1', '--max-jobs', '1'],
                { timeout: 10000, maxBuffer: 16384, env: { LANG: 'C', LC_ALL: 'C' } },
            );
            task.child.stdin?.end(profile.source);
            await task;
        }
    },
);
