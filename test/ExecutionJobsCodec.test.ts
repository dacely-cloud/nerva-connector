// SPDX-FileCopyrightText: 2026 Nerva contributors
// SPDX-License-Identifier: LicenseRef-Proprietary

import { expect, it } from 'vitest';
import { ExecutionResultCodec } from '../src/execution/ExecutionResultCodec.js';
import { ExecutionJobsCodec } from '../src/execution/ExecutionJobsCodec.js';
import {
    ExecutionTermination,
    ExecutionFailure,
    ExecutionSetupFailure,
    type ExecutionResult,
} from 'nerva-connector-protocol/execution/ExecutionTypes.js';

/** Successful output and setup failures have disjoint trusted meanings. */
const completed: ExecutionResult = {
    setupFailure: null,
    termination: ExecutionTermination.Exited,
    failure: null,
    exitCode: 0,
    stdoutBase64: '',
    stderrBase64: '',
};

it('untrusted terminal results cannot hide incomplete execution or exceed the combined output limit', (): void => {
    expect(ExecutionResultCodec.read(completed)).toEqual(completed);
    for (const changed of [
        { termination: 'unknown' },
        { failure: ExecutionFailure.Timeout },
        { exitCode: 125 },
        { exitCode: 128 },
        { termination: ExecutionTermination.Indeterminate },
        { setupFailure: ExecutionSetupFailure.Bootstrap },
        { stdoutBase64: 'Zg' },
        { stdoutBase64: 'Zg==\n' },
        { stdoutBase64: Buffer.alloc(65537).toString('base64') },
        {
            stdoutBase64: Buffer.alloc(32769).toString('base64'),
            stderrBase64: Buffer.alloc(32768).toString('base64'),
        },
        { rawNativeError: '/private/host/key.json' },
    ]) {
        expect((): void => {
            ExecutionResultCodec.read({ ...completed, ...changed });
        }).toThrow();
    }
    const setup: ExecutionResult = {
        ...completed,
        termination: ExecutionTermination.Indeterminate,
        failure: ExecutionFailure.Sandbox,
        exitCode: null,
        setupFailure: ExecutionSetupFailure.Configuration,
    };
    expect(ExecutionResultCodec.read(setup)).toEqual(setup);
    expect((): void => {
        ExecutionResultCodec.read({
            ...setup,
            stderrBase64: Buffer.from('/private/host').toString('base64'),
        });
    }).toThrow();
    expect((): void => {
        ExecutionResultCodec.read({
            ...completed,
            termination: ExecutionTermination.Indeterminate,
            failure: ExecutionFailure.Expired,
            exitCode: null,
            stdoutBase64: Buffer.from('unretained').toString('base64'),
        });
    }).toThrow();
});

it('interrupted results retain canonical observed binary output without a successful exit or setup diagnostic', (): void => {
    const result: ExecutionResult = {
        ...ExecutionResultCodec.interrupted(ExecutionFailure.Interrupted),
        stdoutBase64: Buffer.from([0xef, 0xbb, 0xbf, 0, 255]).toString('base64'),
        stderrBase64: Buffer.from([0, 254]).toString('base64'),
    };
    expect(ExecutionResultCodec.read(result)).toEqual(result);
    expect((): void => {
        ExecutionResultCodec.read({ ...result, exitCode: 0 });
    }).toThrow();
    expect((): void => {
        ExecutionResultCodec.read({ ...result, setupFailure: ExecutionSetupFailure.Execute });
    }).toThrow();
});

it('remote command requests cannot acquire host paths, fixed arguments, resource policy or environment authority through extra fields', (): void => {
    const request: Readonly<Record<string, string | readonly string[]>> = {
        requestId: 'request',
        policySha256: 'a'.repeat(64),
        rootId: 'project',
        programId: 'tool',
        arguments: ['data'],
    };
    expect(ExecutionJobsCodec.request(request).arguments).toEqual(['data']);
    for (const field of [
        'programPath',
        'cwd',
        'environment',
        'timeoutMs',
        'children',
        'privateKeyFile',
    ]) {
        expect((): void => {
            ExecutionJobsCodec.request({ ...request, [field]: 'untrusted' });
        }).toThrow();
    }
    expect((): void => {
        ExecutionJobsCodec.request({ ...request, arguments: ['\ud800'] });
    }).toThrow();
});

it('public grants reject fixed local argument disclosure and ungranted program/root combinations', (): void => {
    const profile: Readonly<Record<string, unknown>> = {
        revision: '1',
        policySha256: 'a'.repeat(64),
        roots: [{ id: 'project', access: 'read-only' }],
        programs: [
            { id: 'tool', rootIds: ['project'], arguments: [{ kind: 'text', maximumBytes: 32 }] },
        ],
        resources: { memoryBytes: '67108864', maximumTasks: 8, cpuQuotaMicros: 50000 },
        timeoutMs: 5000,
        maximumAddressBytes: '1073741824',
        maximumFileBytes: '4096',
    };
    expect(ExecutionJobsCodec.profile(profile).programs[0]?.id).toBe('tool');
    for (const programs of [
        [
            {
                id: 'tool',
                rootIds: ['project'],
                arguments: [{ kind: 'literal', value: 'private-fixed-secret' }],
            },
        ],
        [{ id: 'tool', rootIds: ['other-root'], arguments: [] }],
        [{ id: 'tool', rootIds: ['project'], arguments: [], path: '/host/program' }],
    ]) {
        expect((): void => {
            ExecutionJobsCodec.profile({ ...profile, programs });
        }).toThrow();
    }
});
