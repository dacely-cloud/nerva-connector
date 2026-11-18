// SPDX-FileCopyrightText: 2026 Nerva contributors
// SPDX-License-Identifier: LicenseRef-Proprietary

import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { readdir, lstat } from 'node:fs/promises';
import { ProtectedFiles } from '../local/ProtectedFiles.js';
import {
    ExecutionAppArmorProfile,
    ExecutionAppArmorMode,
    type ExecutionAppArmorDefinition,
} from './ExecutionAppArmorProfile.js';
import type { ExecutionPolicyDefinition } from 'nerva-connector-protocol/execution/ExecutionPolicyTypes.js';
import { ExecutionAppArmorRequirements } from './ExecutionAppArmorRequirements.js';

/** Only explicit local parser operations are available to installation. */
enum ExecutionProfileOperation {
    Install = '--replace',
    Remove = '--remove',
}

/** Explicit local installation role, never invoked by normal execution or remote request handling. No sudo, PATH lookup or network operation is used. */
export class ExecutionAppArmorInstaller {
    /** Startup verifies every policy-selected mode before any local execution profile is published. */
    public static async assertRequired(definition: ExecutionPolicyDefinition): Promise<void> {
        for (const mode of ExecutionAppArmorRequirements.modes(definition)) {
            await this.assertInstalled(definition, mode);
        }
    }

    /** Explicit installation prepares only the modes granted by the protected local policy. */
    public static async installRequired(definition: ExecutionPolicyDefinition): Promise<void> {
        for (const mode of ExecutionAppArmorRequirements.modes(definition)) {
            await this.install(definition, mode);
        }
        await this.assertRequired(definition);
    }

    /** Every exact profile for the requested mode must enforce before that mode can be admitted. */
    public static async assertInstalled(
        definition: ExecutionPolicyDefinition,
        mode: ExecutionAppArmorMode = ExecutionAppArmorMode.Foreground,
    ): Promise<void> {
        const profile: ExecutionAppArmorDefinition = ExecutionAppArmorProfile.generate(
            definition,
            mode,
        );
        const bytes: Buffer = await ProtectedFiles.readTrusted(
            '/sys/kernel/security/apparmor/profiles',
            1048576,
            false,
        );
        const names: readonly string[] = bytes.toString('utf8').split('\n');
        if (
            !names.includes(profile.name + ' (enforce)') ||
            !names.includes(profile.launcherName + ' (enforce)') ||
            (profile.guardianName !== null && !names.includes(profile.guardianName + ' (enforce)'))
        ) {
            throw new Error('The exact enforcing command profiles are not installed');
        }
    }
    /** The operator must authorize this policy and hold installation exclusivity; unprivileged setup fails rather than weakening confinement. */
    public static async install(
        definition: ExecutionPolicyDefinition,
        mode: ExecutionAppArmorMode = ExecutionAppArmorMode.Foreground,
    ): Promise<ExecutionAppArmorDefinition> {
        const profile: ExecutionAppArmorDefinition = ExecutionAppArmorProfile.generate(
            definition,
            mode,
        );
        await this.#apply(profile, ExecutionProfileOperation.Install);
        return profile;
    }

    /** Removing a live profile could unconfine a payload; the exclusive installer must join all owners and prove empty job delegation first. */
    public static async remove(
        definition: ExecutionPolicyDefinition,
        mode: ExecutionAppArmorMode = ExecutionAppArmorMode.Foreground,
    ): Promise<void> {
        if (
            (await readdir(definition.cgroupRoot)).some((name: string): boolean =>
                name.startsWith('exec-'),
            )
        ) {
            throw new Error('Cannot remove an execution profile with retained job cgroups');
        }
        await this.#apply(
            ExecutionAppArmorProfile.generate(definition, mode),
            ExecutionProfileOperation.Remove,
        );
    }

    static async #apply(
        profile: ExecutionAppArmorDefinition,
        operation: ExecutionProfileOperation,
    ): Promise<void> {
        const parser: string = '/usr/sbin/apparmor_parser';
        await ProtectedFiles.directory('/usr/sbin');
        const status: Awaited<ReturnType<typeof lstat>> = await lstat(parser);
        if (!status.isFile() || status.uid !== 0 || (status.mode & 0o6022) !== 0) {
            throw new Error('Trusted operating-system AppArmor parser required');
        }
        const task: ReturnType<typeof execFile.__promisify__> = promisify(execFile)(
            parser,
            [operation, '--skip-cache'],
            { env: { LANG: 'C', LC_ALL: 'C' }, timeout: 10000, maxBuffer: 16384 },
        );
        task.child.stdin?.end(profile.source);
        try {
            await task;
        } catch {
            throw new Error('Explicit AppArmor policy installation failed');
        }
    }
}
