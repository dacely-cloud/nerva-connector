// SPDX-FileCopyrightText: 2026 Nerva contributors
// SPDX-License-Identifier: LicenseRef-Proprietary

import { createHash } from 'node:crypto';
import { ExecutionWorkspaceAccess } from 'nerva-connector-protocol/execution/ExecutionTypes.js';
import type {
    ExecutionPolicyDefinition,
    ExecutionProgramPolicy,
    ExecutionRootPolicy,
    ExecutionBinaryPolicy,
} from 'nerva-connector-protocol/execution/ExecutionPolicyTypes.js';

/** Exact operator-installed policy allows implicit loader mappings without allowing the loader itself as a command. */
export interface ExecutionAppArmorDefinition {
    readonly name: string;
    readonly launcherName: string;
    readonly source: string;
    readonly guardianName: string | null;
}

/** Interactive supervision receives its own explicit policy; ordinary commands gain no trace permission. */
export enum ExecutionAppArmorMode {
    Foreground = 'foreground',
    Pipe = 'pipe',
}

/** AppArmor execution mediation complements Landlock's filesystem grants; runtime code never loads a permissive fallback profile. */
export class ExecutionAppArmorProfile {
    /** Profile ownership and canonical rule bytes produce one deterministic installation-scoped name. */
    public static generate(
        definition: ExecutionPolicyDefinition,
        mode: ExecutionAppArmorMode = ExecutionAppArmorMode.Foreground,
    ): ExecutionAppArmorDefinition {
        if (mode !== ExecutionAppArmorMode.Foreground && mode !== ExecutionAppArmorMode.Pipe) {
            throw new Error('Explicit supported execution profile mode required');
        }
        if (!/^[a-f0-9]{32}$/u.test(definition.installationId)) {
            throw new Error('Permanent execution installation identity required');
        }
        const paths: readonly string[] = [
            ...new Set(
                definition.programs.flatMap(
                    (program: ExecutionProgramPolicy): readonly string[] => [
                        program.path,
                        ...program.children.map(
                            (binary: ExecutionBinaryPolicy): string => binary.path,
                        ),
                    ],
                ),
            ),
        ].sort();
        if (
            paths.length === 0 ||
            paths.some(
                (path: string): boolean =>
                    !/^\/(?:usr|opt)\/[A-Za-z0-9_./+-]+$/u.test(path) ||
                    path.includes('/../') ||
                    path.includes('/./'),
            )
        ) {
            throw new Error('Exact literal executable paths required for AppArmor');
        }
        const writable: boolean = definition.roots.some(
            (root: ExecutionRootPolicy): boolean =>
                root.access === ExecutionWorkspaceAccess.ReadWrite,
        );
        const body: string = [
            '  /** mr,',
            '  /tmp/ rw,',
            '  /tmp/** rwk,',
            '  /dev/null rw,',
            '  unix,',
            ...(writable ? ['  /workspace/ rw,', '  /workspace/** rwk,'] : []),
            ...paths.map((path: string): string => '  "' + path + '" ix,'),
            '  signal (receive),',
            '  signal (send) peer="@PROFILE@//&@LAUNCHER@",',
            ...(mode === ExecutionAppArmorMode.Pipe
                ? [
                      '  ptrace (readby,tracedby) peer="@GUARDIAN@//&@LAUNCHER@",',
                      '  signal (send) peer="@GUARDIAN@//&@LAUNCHER@",',
                      '  signal (send) set=(stop) peer="@PROFILE@//&@GUARDIAN@//&@LAUNCHER@",',
                  ]
                : []),
        ].join('\n');
        const launcher: string = [
            '  / rw,',
            '  /** mrwlk,',
            '  capability,',
            '  userns,',
            '  mount,',
            '  umount,',
            '  pivot_root,',
            '  network unix,',
            '  network netlink,',
            '  signal,',
            '  ptrace (read,readby) peer=@LAUNCHER@,',
            '  "/usr/bin/bwrap" ix,',
            '  "/nerva-exec" ix,',
            ...paths.map((path: string): string => '  "' + path + '" ix,'),
            '  change_profile -> &@PROFILE@,',
            ...(mode === ExecutionAppArmorMode.Pipe
                ? [
                      '  change_profile -> &@GUARDIAN@,',
                      '  ptrace (read,trace) peer="@PROFILE@//&@GUARDIAN@//&@LAUNCHER@",',
                      '  ptrace (readby,tracedby) peer="@GUARDIAN@//&@LAUNCHER@",',
                  ]
                : []),
        ].join('\n');
        const guardian: string | null =
            mode === ExecutionAppArmorMode.Pipe
                ? [
                      '  /** mr,',
                      '  /proc/*/attr/current rw,',
                      '  /proc/*/task/*/attr/current rw,',
                      '  /tmp/ rw,',
                      '  /tmp/** rwk,',
                      '  /dev/null rw,',
                      '  unix,',
                      ...(writable ? ['  /workspace/ rw,', '  /workspace/** rwk,'] : []),
                      ...paths.map((path: string): string => '  "' + path + '" ix,'),
                      '  signal (receive),',
                      '  signal (send) peer="@PROFILE@//&@GUARDIAN@//&@LAUNCHER@",',
                      '  ptrace (read,trace) peer="@PROFILE@//&@GUARDIAN@//&@LAUNCHER@",',
                      '  ptrace (readby,tracedby) peer="@GUARDIAN@//&@LAUNCHER@",',
                      '  change_profile -> &@PROFILE@,',
                  ].join('\n')
                : null;
        const abi: string = 'abi <abi/4.0>,\n';
        const hash: string = createHash('sha256')
            .update(abi + body + '\n' + launcher + (guardian === null ? '' : '\n' + guardian))
            .digest('hex');
        const name: string = 'nerva-connector-exec-' + definition.installationId + '-' + hash;
        const launcherName: string =
            'nerva-connector-launch-' + definition.installationId + '-' + hash;
        const guardianName: string | null =
            guardian === null
                ? null
                : 'nerva-connector-guard-' + definition.installationId + '-' + hash;
        const render: (source: string) => string = (source: string): string =>
            source
                .replaceAll('@PROFILE@', name)
                .replaceAll('@LAUNCHER@', launcherName)
                .replaceAll('@GUARDIAN@', guardianName ?? '');
        return {
            name,
            launcherName,
            guardianName,
            source:
                abi +
                'profile ' +
                name +
                ' flags=(attach_disconnected,mediate_deleted) {\n' +
                render(body) +
                '\n}\n' +
                'profile ' +
                launcherName +
                ' flags=(attach_disconnected,mediate_deleted) {\n' +
                render(launcher) +
                '\n}\n' +
                (guardian === null || guardianName === null
                    ? ''
                    : 'profile ' +
                      guardianName +
                      ' flags=(attach_disconnected,mediate_deleted) {\n' +
                      render(guardian) +
                      '\n}\n'),
        };
    }
}
