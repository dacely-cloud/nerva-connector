// SPDX-FileCopyrightText: 2026 Nerva contributors
// SPDX-License-Identifier: LicenseRef-Proprietary

import {
    type ExecutionPolicyDefinition,
    type ExecutionProgramPolicy,
} from '../../src/execution/ExecutionPolicyTypes.js';
import { ExecutionArgumentKind } from 'nerva-connector-protocol/execution/ExecutionArgumentKind.js';
import { ExecutionMachineRuleCodec } from '../../src/execution/ExecutionMachineRuleCodec.js';
import {
    ExecutionMachineMode,
    type ExecutionMachineInvocationRule,
    type ExecutionMachineShellInvocation,
    type ExecutionMachineArgvInvocation,
} from 'nerva-connector-protocol/execution/ExecutionMachineInvocation.js';
import { ExecutionWorkspaceAccess } from '../../src/execution/ExecutionTypes.js';

/** Pure fixtures contain no opened files, installed native helpers or live credentials. */
export class ExecutionMachineFixture {
    /** Two public aliases resolve only the owning policy's primary shell and one pinned child. */
    public static rule(): ExecutionMachineInvocationRule {
        return ExecutionMachineRuleCodec.read({
            kind: ExecutionArgumentKind.MachineInvocation,
            shell: { executableIndex: 0, fixedArguments: ['--noprofile', '--norc', '-c'] },
            commands: [
                { alias: 'node', executableIndex: 1 },
                { alias: 'shell-binary', executableIndex: 0 },
            ],
            maximumCwdBytes: 512,
            environment: [
                { name: 'APP_MODE', maximumBytes: 512 },
                { name: 'LANG', maximumBytes: 512 },
            ],
            maximumEnvironmentBytes: 1024,
            maximumStdinBytes: 1024,
            maximumTimeoutMs: 5000,
            maximumArguments: 32,
            maximumArgumentBytes: 1024,
            maximumArgumentsBytes: 2048,
            maximumScriptBytes: 2048,
        });
    }

    /** Real private pin fields stay separate from public aliases and the new published input rule. */
    public static program(
        rule: ExecutionMachineInvocationRule = this.rule(),
    ): ExecutionProgramPolicy {
        return {
            id: 'machine',
            rootIds: ['project'],
            path: '/usr/bin/bash',
            sha256: 'a'.repeat(64),
            children: [{ path: '/usr/bin/node', sha256: 'b'.repeat(64) }],
            arguments: [rule],
        };
    }

    /** These paths are validation data only and never opened by pure codec tests. */
    public static policy(
        rule: ExecutionMachineInvocationRule = this.rule(),
    ): ExecutionPolicyDefinition {
        return {
            installationId: 'a'.repeat(32),
            revision: 1n,
            trampolineFile: '/opt/nerva/exec',
            trampolineSha256: 'c'.repeat(64),
            bubblewrapFile: '/usr/bin/bwrap',
            bubblewrapSha256: 'd'.repeat(64),
            runtimeDirectory: '/opt/nerva/runtime',
            cgroupRoot: '/sys/fs/cgroup/nerva',
            roots: [
                { id: 'project', path: '/srv/project', access: ExecutionWorkspaceAccess.ReadWrite },
            ],
            programs: [this.program(rule)],
            resources: { memoryBytes: 67108864n, maximumTasks: 8, cpuQuotaMicros: 50000 },
            timeoutMs: 5000,
            maximumAddressBytes: 1073741824n,
            maximumFileBytes: 4096n,
        };
    }

    /** Signed shell input has no host executable path or inferred command alias. */
    public static shell(): ExecutionMachineShellInvocation {
        return {
            mode: ExecutionMachineMode.Shell,
            script: 'printf hello',
            cwd: '.',
            environment: [],
            stdin: '',
            timeoutMs: 1000,
        };
    }

    /** Input argv is already separated and cannot become shell text through joining. */
    public static argv(): ExecutionMachineArgvInvocation {
        return {
            mode: ExecutionMachineMode.Argv,
            command: 'node',
            argv: ['--version'],
            cwd: 'src',
            environment: [
                { name: 'APP_MODE', value: 'test' },
                { name: 'LANG', value: 'C.UTF-8' },
            ],
            stdin: '',
            timeoutMs: 1000,
        };
    }
}
