// SPDX-FileCopyrightText: 2026 Dacely <business@dacely.com>
// SPDX-License-Identifier: LicenseRef-Proprietary

import { randomBytes } from 'node:crypto';
import { readFile, readdir, stat, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import type { ExecutionEffectAdmission } from '../../src/execution/ExecutionEffectAdmission.js';
import type { ExecutionCgroupIdentity } from '../../src/execution/ExecutionCgroupIdentity.js';
import { ExecutionPolicy } from '../../src/execution/ExecutionPolicy.js';
import { ExecutionPolicyCodec } from '../../src/execution/ExecutionPolicyCodec.js';
import { ExecutionAppArmorInstaller } from '../../src/execution/ExecutionAppArmorInstaller.js';
import {
    ExecutionAppArmorProfile,
    type ExecutionAppArmorDefinition,
} from '../../src/execution/ExecutionAppArmorProfile.js';
import { ProtectedFiles } from '../../src/local/ProtectedFiles.js';
import type { ExecutionPolicyDefinition } from 'nerva-connector-protocol/execution/ExecutionPolicyTypes.js';
import {
    ExecutionTermination,
    ExecutionFailure,
    type ExecutionResult,
} from 'nerva-connector-protocol/execution/ExecutionTypes.js';

/** This finite test peer contains only the customer's execution policy/runner; it has no account, Nexa or infrastructure identity. */
const args: readonly string[] = process.argv.slice(2);
/** Bounded setup stages expose no native diagnostic, host path or credential on qualification failure. */
enum ExecutionQualificationStage {
    Profile = 'profile',
    Policy = 'policy',
    Kernel = 'kernel',
    Tasks = 'tasks',
    Resources = 'resources',
    Verify = 'verify',
    Lifecycle = 'lifecycle',
}
let stage: ExecutionQualificationStage = ExecutionQualificationStage.Profile;
if (args.length !== 2 || args[0] !== '--config' || args[1] === undefined) {
    throw new Error('Explicit execution qualification policy required');
}
try {
    const raw: unknown = JSON.parse(
        new TextDecoder('utf-8', { fatal: true }).decode(
            await ProtectedFiles.readPrivate(args[1], 65536),
        ),
    );
    const definition: ExecutionPolicyDefinition = ExecutionPolicyCodec.policy(raw);
    const profile: ExecutionAppArmorDefinition = ExecutionAppArmorProfile.generate(definition);
    await writeFile(join(dirname(args[1]), 'apparmor-profile.txt'), profile.source, {
        mode: 0o600,
        flag: 'wx',
    });
    await ExecutionAppArmorInstaller.install(definition);
    stage = ExecutionQualificationStage.Policy;
    await using policy: ExecutionPolicy = await ExecutionPolicy.load(args[1], []);
    const admissionExpiresAtMs: bigint = BigInt(Date.now()) + 30000n;
    const admission: () => Promise<ExecutionEffectAdmission> =
        async (): Promise<ExecutionEffectAdmission> => ({
            context: await policy.effectContext('project'),
            expiresAtMs: admissionExpiresAtMs,
            assertLaunch: (): void => {
                if (BigInt(Date.now()) >= admissionExpiresAtMs) {
                    throw new Error('Fixture admission expired');
                }
            },
            commit: async (_group: ExecutionCgroupIdentity): Promise<void> => {},
        });
    const invoke: (action: string) => Promise<ExecutionResult> = async (
        action: string,
    ): Promise<ExecutionResult> =>
        await policy.execute(
            {
                policySha256: policy.policySha256,
                programId: 'probe',
                rootId: 'project',
                arguments: [action],
            },
            randomBytes(32).toString('hex'),
            AbortSignal.timeout(10000),
            await admission(),
        );
    stage = ExecutionQualificationStage.Kernel;
    const baseline: ExecutionResult = await invoke('read-write');
    if (
        baseline.termination !== ExecutionTermination.Exited ||
        baseline.exitCode !== 0 ||
        !Buffer.from(baseline.stdoutBase64, 'base64').toString().includes('denials verified')
    ) {
        const diagnostic: string = Buffer.from(baseline.stderrBase64, 'base64').toString();
        process.stderr.write(
            JSON.stringify({
                termination: baseline.termination,
                failure: baseline.failure,
                exitCode: baseline.exitCode,
                setupFailure: baseline.setupFailure,
                probe: /^probe failed: [a-z ]+ \([0-9]+\)\n$/u.test(diagnostic)
                    ? diagnostic.trim()
                    : null,
            }) + '\n',
        );
        throw new Error('Actual kernel denial probe failed');
    }
    stage = ExecutionQualificationStage.Tasks;
    const tasks: ExecutionResult = await invoke('tasks');
    if (
        tasks.exitCode !== 0 ||
        !Buffer.from(tasks.stdoutBase64, 'base64').toString().includes('tasks bounded')
    ) {
        throw new Error('Actual task bound was not proven');
    }
    stage = ExecutionQualificationStage.Resources;
    for (const action of ['loop', 'output', 'memory', 'file-limit', 'descendant']) {
        const result: ExecutionResult = await invoke(action);
        if (action !== 'descendant' && result.termination !== ExecutionTermination.Indeterminate) {
            throw new Error('Resource interruption was not retained as uncertain');
        }
        if (
            (action === 'loop' && result.failure !== ExecutionFailure.Timeout) ||
            (action === 'output' && result.failure !== ExecutionFailure.OutputLimit)
        ) {
            throw new Error('Actual resource boundary was not proven');
        }
        if (
            Buffer.from(result.stdoutBase64, 'base64').byteLength +
                Buffer.from(result.stderrBase64, 'base64').byteLength >
            65536
        ) {
            throw new Error('Execution output exceeded its bound');
        }
    }
    stage = ExecutionQualificationStage.Verify;
    const root: string | undefined = policy.definition.roots[0]?.path;
    if (
        root === undefined ||
        (await readFile(root + '/input', 'utf8')) !== 'safe' ||
        (await readFile(root + '/output', 'utf8')) !== 'sandboxed' ||
        (await stat(root + '/large')).size > 4096
    ) {
        throw new Error('Actual filesystem outcome was not proven');
    }
    if (
        (await readdir(policy.definition.cgroupRoot)).some((name: string): boolean =>
            name.startsWith('exec-'),
        )
    ) {
        throw new Error('An execution retained live descendants or cgroup state');
    }
    stage = ExecutionQualificationStage.Lifecycle;
    const invokeHeld: (action: string, signal: AbortSignal) => Promise<ExecutionResult> = async (
        action: string,
        signal: AbortSignal,
    ): Promise<ExecutionResult> =>
        await policy.execute(
            {
                policySha256: policy.policySha256,
                programId: 'probe',
                rootId: 'project',
                arguments: [action],
            },
            randomBytes(32).toString('hex'),
            signal,
            await admission(),
        );
    const cancel: AbortController = new AbortController();
    const first: Promise<ExecutionResult> = invokeHeld('hold-a', cancel.signal);
    const second: Promise<ExecutionResult> = invokeHeld('hold-b', AbortSignal.timeout(10000));
    const deadline: number = performance.now() + 2000;
    for (const action of ['hold-a', 'hold-b']) {
        while (true) {
            try {
                if ((await readFile(join(root, action), 'utf8')) === 'running') {
                    break;
                }
            } catch (caught: unknown) {
                if (!(caught instanceof Error) || !('code' in caught) || caught.code !== 'ENOENT') {
                    throw caught;
                }
            }
            if (performance.now() >= deadline) {
                throw new Error('Held payload was not observed');
            }
            await delay(10);
        }
    }
    let rejected: boolean = false;
    try {
        await invokeHeld('hold-a', AbortSignal.timeout(10000));
    } catch {
        rejected = true;
    }
    if (!rejected) {
        throw new Error('Concurrent job admission exceeded its limit');
    }
    cancel.abort();
    if ((await first).failure !== ExecutionFailure.Cancelled) {
        throw new Error('Cancelled job was not retained as interrupted');
    }
    await policy[Symbol.asyncDispose]();
    if (
        (await second).termination !== ExecutionTermination.Indeterminate ||
        (await readdir(definition.cgroupRoot)).some((name: string): boolean =>
            name.startsWith('exec-'),
        )
    ) {
        throw new Error('Shutdown did not join the owned process trees');
    }
    process.stdout.write(
        'NERVA_CONNECTOR_EXEC_BOUNDARY_QUALIFIED ' +
            JSON.stringify({
                namespaceIsolation: true,
                apparmorEnforced: true,
                dynamicLoaderBypassesDenied: true,
                noAmbientHostAccess: true,
                executableRestrictions: true,
                noInheritedSecrets: true,
                networkDenied: true,
                readonlyRuntime: true,
                boundedTasks: true,
                boundedMemory: true,
                boundedFiles: true,
                boundedOutput: true,
                boundedTime: true,
                descendantsJoined: true,
                boundedConcurrency: true,
                cancellationJoined: true,
                shutdownJoined: true,
                signedRemoteExecutionEnabled: false,
            }) +
            '\n',
    );
} catch {
    process.stderr.write('Execution boundary qualification failed at ' + stage + '\n');
    process.exitCode = 1;
}
