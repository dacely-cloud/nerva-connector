// SPDX-FileCopyrightText: 2026 Nerva contributors
// SPDX-License-Identifier: LicenseRef-Proprietary

import { ExecutionInputCodec } from 'nerva-connector-protocol/execution/ExecutionInputCodec.js';
import { randomBytes, createHash } from 'node:crypto';
import { writeFile, rename, readdir, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { expect, it } from 'vitest';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { ExecutionPolicy } from '../src/execution/ExecutionPolicy.js';
import { ExecutionPolicyCodec } from '../src/execution/ExecutionPolicyCodec.js';
import {
    ExecutionWorkspaceAccess,
    ExecutionTermination,
    type ExecutionResult,
} from 'nerva-connector-protocol/execution/ExecutionTypes.js';
import {
    type ExecutionInvocation,
    type ExecutionPolicyDefinition,
} from 'nerva-connector-protocol/execution/ExecutionPolicyTypes.js';
import { ExecutionArgumentKind } from 'nerva-connector-protocol/execution/ExecutionArgumentKind.js';
import { ExecutionFixture } from './support/ExecutionFixture.js';

const helper: string | undefined = process.env['NERVA_CONNECTOR_EXEC_HELPER'];

it.skipIf(helper === undefined)(
    'a real Node runtime executes granted code and children while filesystem and network restrictions remain active',
    async (): Promise<void> => {
        if (helper === undefined) {
            throw new Error('Explicit native execution helper required');
        }
        await using fixture: ExecutionFixture = await ExecutionFixture.create(helper);
        await fixture.installProgram('/usr/bin/node', '/usr/bin/node');
        const path: string = await fixture.policy(helper, ExecutionWorkspaceAccess.ReadOnly);
        const raw: unknown = JSON.parse(await readFile(path, 'utf8'));
        const original: ExecutionPolicyDefinition = ExecutionPolicyCodec.policy(raw);
        const script: string = `import fs from 'node:fs';import net from 'node:net';import {spawnSync} from 'node:child_process';
if(fs.readFileSync('/workspace/input','utf8')!=='safe')throw Error('read');
let denied=false;try{fs.writeFileSync('/workspace/denied','x')}catch(error){denied=['EROFS','EACCES'].includes(error.code)}if(!denied)throw Error('write');
if(spawnSync('/usr/bin/forbidden',['forbidden']).error?.code!=='EACCES')throw Error('executable');
const loader='/lib64/ld-linux-x86-64.so.2';if(spawnSync(loader,['/usr/bin/forbidden','forbidden']).error?.code!=='EACCES')throw Error('loader');
const ld=fs.openSync(loader,'r');if(spawnSync('/proc/self/fd/3',['/usr/bin/forbidden','forbidden'],{stdio:['ignore','pipe','pipe',ld]}).error?.code!=='EACCES')throw Error('loader descriptor');fs.closeSync(ld);
const child=spawnSync('/usr/bin/node',['--eval',"console.log('child')"]);if(child.status!==0||child.stdout.toString().trim()!=='child')throw Error('allowed child '+JSON.stringify({status:child.status,error:child.error?.code,stderr:child.stderr?.toString()}));
const socket=net.connect({host:'1.1.1.1',port:443});socket.on('error',error=>{if(error.code!=='EPERM')throw error;console.log('Node code and child ran; writes, other executables and sockets denied')});`;
        const definition: ExecutionPolicyDefinition = {
            ...original,
            resources: { ...original.resources, memoryBytes: 268435456n, maximumTasks: 32 },
            maximumAddressBytes: 17592186044416n,
            programs: [
                {
                    id: 'node-probe',
                    rootIds: ['project'],
                    path: '/usr/bin/node',
                    sha256: createHash('sha256')
                        .update(await readFile('/usr/bin/node'))
                        .digest('hex'),
                    arguments: [
                        { kind: ExecutionArgumentKind.Literal, value: '--input-type=module' },
                        { kind: ExecutionArgumentKind.Literal, value: '--eval' },
                        { kind: ExecutionArgumentKind.Literal, value: script },
                    ],
                    children: [],
                },
            ],
        };
        await writeFile(
            path,
            JSON.stringify(definition, (_key: string, value: unknown): unknown =>
                typeof value === 'bigint' ? value.toString() : value,
            ),
            { mode: 0o600 },
        );
        await fixture.installProfile(definition);
        await using policy: ExecutionPolicy = await ExecutionPolicy.load(path, []);
        const result: ExecutionResult = await policy.execute(
            {
                policySha256: policy.policySha256,
                programId: 'node-probe',
                rootId: 'project',
                arguments: [],
            },
            randomBytes(32).toString('hex'),
            AbortSignal.timeout(10000),
            await fixture.policyAdmission(policy),
        );
        expect(result, Buffer.from(result.stderrBase64, 'base64').toString()).toMatchObject({
            termination: ExecutionTermination.Exited,
            exitCode: 0,
        });
        expect(Buffer.from(result.stdoutBase64, 'base64').toString()).toContain(
            'Node code and child ran',
        );
    },
    20000,
);

it.skipIf(helper === undefined)(
    'explicit local policy denies changed arguments and authority, and pins executable bytes across pathname replacement',
    async (): Promise<void> => {
        if (helper === undefined) {
            throw new Error('Explicit native execution helper required');
        }
        await using fixture: ExecutionFixture = await ExecutionFixture.create(helper);
        const path: string = await fixture.policy(helper, ExecutionWorkspaceAccess.ReadOnly);
        await using policy: ExecutionPolicy = await ExecutionPolicy.load(path, []);
        const request: ExecutionInvocation = {
            policySha256: policy.policySha256,
            programId: 'probe',
            rootId: 'project',
            arguments: [],
        };
        for (const changed of [
            { ...request, arguments: ['read-write'] },
            { ...request, programId: 'other' },
            { ...request, rootId: 'other' },
            { ...request, policySha256: '0'.repeat(64) },
        ]) {
            await expect(
                policy.execute(
                    changed,
                    randomBytes(32).toString('hex'),
                    AbortSignal.timeout(6000),
                    await fixture.policyAdmission(policy),
                ),
            ).rejects.toThrow();
        }
        expect(
            (await readdir(fixture.delegation)).some((name: string): boolean =>
                name.startsWith('exec-'),
            ),
        ).toBe(false);
        const binary: string = join(fixture.runtime, 'usr/bin/probe');
        await rename(binary, binary + '-retained');
        await writeFile(binary, '#!/bin/sh\necho UNTRUSTED\n', { mode: 0o700 });
        const result: ExecutionResult = await policy.execute(
            request,
            randomBytes(32).toString('hex'),
            AbortSignal.timeout(6000),
            await fixture.policyAdmission(policy),
        );
        expect(result).toMatchObject({ termination: ExecutionTermination.Exited, exitCode: 0 });
        expect(Buffer.from(result.stdoutBase64, 'base64').toString()).toContain('denials verified');
        expect(Buffer.from(result.stdoutBase64, 'base64').toString()).not.toContain('UNTRUSTED');
        await expect(ExecutionPolicy.load(path, [])).rejects.toThrow();
    },
    15000,
);

it.skipIf(helper === undefined)(
    'execution roots and runtime cannot publish protected configuration or device state',
    async (): Promise<void> => {
        if (helper === undefined) {
            throw new Error('Explicit native execution helper required');
        }
        await using fixture: ExecutionFixture = await ExecutionFixture.create(helper);
        const path: string = await fixture.policy(helper, ExecutionWorkspaceAccess.ReadOnly);
        await expect(
            ExecutionPolicy.load(path, [join(fixture.workspace, 'device-key.json')]),
        ).rejects.toThrow();
        await expect(
            ExecutionPolicy.load(path, [join(fixture.runtime, 'private-state')]),
        ).rejects.toThrow();
    },
);

it('invocations cannot select a shell, environment or host path through extra fields', (): void => {
    const input: ExecutionInvocation = {
        policySha256: 'a'.repeat(64),
        programId: 'probe',
        rootId: 'project',
        arguments: [],
    };
    for (const field of [
        'environment',
        'command',
        'programPath',
        'runtimeDirectory',
        'maximumTasks',
    ]) {
        expect((): void => {
            ExecutionInputCodec.invocation({ ...input, [field]: 'untrusted' });
        }).toThrow();
    }
    expect((): void => {
        ExecutionInputCodec.invocation({ ...input, arguments: ['\ud800'] });
    }).toThrow();
});

it.skipIf(helper === undefined)(
    'dynamic ELF loading succeeds while direct, descriptor and absolute execveat loader bypasses fail',
    async (): Promise<void> => {
        if (helper === undefined) {
            throw new Error('Explicit native execution helper required');
        }
        await using fixture: ExecutionFixture = await ExecutionFixture.create(helper);
        await promisify(execFile)(
            'cc',
            [
                '-O2',
                '-Wall',
                '-Wextra',
                '-Werror',
                '-o',
                join(fixture.runtime, 'usr/bin/probe'),
                'native/test/execution_probe.c',
            ],
            { timeout: 10000, maxBuffer: 8192 },
        );
        const path: string = await fixture.policy(helper, ExecutionWorkspaceAccess.ReadOnly);
        await using policy: ExecutionPolicy = await ExecutionPolicy.load(path, []);
        const result: ExecutionResult = await policy.execute(
            {
                policySha256: policy.policySha256,
                programId: 'probe',
                rootId: 'project',
                arguments: [],
            },
            randomBytes(32).toString('hex'),
            AbortSignal.timeout(6000),
            await fixture.policyAdmission(policy),
        );
        expect(result, Buffer.from(result.stderrBase64, 'base64').toString()).toMatchObject({
            termination: ExecutionTermination.Exited,
            exitCode: 0,
        });
        expect(Buffer.from(result.stdoutBase64, 'base64').toString()).toContain('denials verified');
    },
);
