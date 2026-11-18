// SPDX-FileCopyrightText: 2026 Nerva contributors
// SPDX-License-Identifier: LicenseRef-Proprietary

import { execFile } from 'node:child_process';
import { mkdir, readFile, readdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { expect, it } from 'vitest';
import { ExecutionPipeFixture } from './support/ExecutionPipeFixture.js';
import { ExecutionIdentity } from './support/ExecutionIdentity.js';
import { ConnectorClientExecution } from '../src/runtime/ConnectorClientExecution.js';
import {
    ConnectorPrivateDirectory,
    ConnectorDirectoryPurpose,
} from '../src/runtime/ConnectorPrivateDirectory.js';
import { ExecutionAppArmorInstaller } from '../src/execution/ExecutionAppArmorInstaller.js';
import {
    ExecutionAppArmorMode,
    ExecutionAppArmorProfile,
    type ExecutionAppArmorDefinition,
} from '../src/execution/ExecutionAppArmorProfile.js';
import { ExecutionPolicyCodec } from '../src/execution/ExecutionPolicyCodec.js';
import { ExecutionPairPreparation } from '../src/execution/ExecutionPairPreparation.js';
import { ExecutionConfiguration } from '../src/execution/ExecutionConfiguration.js';
import { ExecutionPolicy } from '../src/execution/ExecutionPolicy.js';
import { ExecutionInteractiveRuleCodec } from 'nerva-connector-protocol/execution/ExecutionInteractiveRuleCodec.js';
import { ExecutionInteractiveTransport } from 'nerva-connector-protocol/execution/ExecutionInteractive.js';
import { ExecutionInputKind } from 'nerva-connector-protocol/execution/ExecutionInput.js';
import { ExecutionMachineFixture } from './support/ExecutionMachineFixture.js';
import {
    type ExecutionPolicyDefinition,
    type ExecutionProgramPolicy,
} from 'nerva-connector-protocol/execution/ExecutionPolicyTypes.js';
import { ExecutionArgumentKind } from 'nerva-connector-protocol/execution/ExecutionArgumentKind.js';
import { type ExecutionPublication } from 'nerva-connector-protocol/execution/ExecutionJobs.js';
import { ExecutionLane } from 'nerva-connector-protocol/execution/ExecutionLane.js';
import type { ExecutionInteractiveInvocationRule } from 'nerva-connector-protocol/execution/ExecutionInteractiveInvocation.js';
import { ExecutionWorkspaceAccess } from 'nerva-connector-protocol/execution/ExecutionTypes.js';
import type { ExecutionDeliveryLink } from '../src/execution/ExecutionDeliveryLink.js';
import type { ConnectorClientFrame } from '../src/protocol/ConnectorTransport.js';
import { ExecutionProof } from 'nerva-connector-protocol/execution/ExecutionProof.js';
import { SignaturePurpose } from 'nerva-connector-protocol/identity/IdentityFormat.js';
import { SigningKey } from '../src/identity/SigningKey.js';

const helper: string | undefined = process.env['NERVA_CONNECTOR_EXEC_HELPER'];

/** Only the fixture's exact, currently unused guardian is removed; restoration and complete owned cleanup remain mandatory. */
async function removeGuardian(profile: ExecutionAppArmorDefinition): Promise<void> {
    const name: string | null = profile.guardianName;
    if (name === null) {
        throw new Error('Exact Pipe guardian required');
    }
    const start: number = profile.source.indexOf('profile ' + name + ' ');
    if (start < 0) {
        throw new Error('Original guardian source required');
    }
    const task: ReturnType<typeof execFile.__promisify__> = promisify(execFile)(
        '/usr/sbin/apparmor_parser',
        ['--remove', '--skip-cache'],
        { timeout: 10000, maxBuffer: 8192, env: { LANG: 'C', LC_ALL: 'C' } },
    );
    task.child.stdin?.end('abi <abi/4.0>,\n' + profile.source.slice(start));
    await task;
}

it.skipIf(helper === undefined)(
    'normal Pipe policy startup verifies real enforcing stacks before journals, then publishes both unchanged encrypted lanes without execution',
    async (): Promise<void> => {
        if (helper === undefined) {
            throw new Error('Explicit native qualification candidate required');
        }
        await using fixture: ExecutionPipeFixture = await ExecutionPipeFixture.create(helper);
        const policyFile: string = await fixture.native.policy(
            helper,
            ExecutionWorkspaceAccess.ReadOnly,
        );
        const raw: unknown = JSON.parse(await readFile(policyFile, 'utf8'));
        const base: ExecutionPolicyDefinition = ExecutionPolicyCodec.policy(raw);
        const program: ExecutionProgramPolicy | undefined = base.programs[0];
        if (program === undefined) {
            throw new Error('Actual pinned native probe required');
        }
        const rule: ExecutionInteractiveInvocationRule = ExecutionInteractiveRuleCodec.read({
            kind: ExecutionArgumentKind.InteractiveInvocation,
            invocation: {
                ...ExecutionMachineFixture.rule(),
                shell: null,
                commands: [{ alias: 'probe', executableIndex: 0 }],
            },
            transports: [ExecutionInteractiveTransport.Pipe],
            controls: [ExecutionInputKind.Data, ExecutionInputKind.End],
            maximumInputBytes: '65536',
            maximumControls: 256,
            maximumResizes: 0,
        });
        const definition: ExecutionPolicyDefinition = {
            ...base,
            programs: [{ ...program, arguments: [rule] }],
        };
        await writeFile(
            policyFile,
            JSON.stringify(definition, (_key: string, value: unknown): unknown =>
                typeof value === 'bigint' ? value.toString() : value,
            ),
            { mode: 0o600 },
        );
        await fixture.native.installProfile(definition, ExecutionAppArmorMode.Pipe);
        await ExecutionAppArmorInstaller.assertRequired(definition);
        const stateDirectory: string = join(fixture.native.directory, 'execution-state');
        await mkdir(stateDirectory, { mode: 0o700 });
        using identity: ExecutionIdentity = new ExecutionIdentity(fixture.native.directory, {
            policyFile,
            stateDirectory,
        });
        {
            await using policy: ExecutionPolicy = await ExecutionConfiguration.loadPolicy(
                identity.identity,
                { policyFile, stateDirectory, lane: ExecutionLane.First },
            );
            expect(policy.definition).toEqual(definition);
        }
        await ExecutionPairPreparation.prepare(identity.identity, true);
        const before: readonly Buffer[] = await Promise.all(
            Object.values(ExecutionLane).map((lane: ExecutionLane): Promise<Buffer> =>
                readFile(join(stateDirectory, lane, 'execution-journal')),
            ),
        );
        expect(before[0]).not.toEqual(before[1]);
        const workspace: readonly string[] = await readdir(fixture.native.workspace);
        const profile: ExecutionAppArmorDefinition = ExecutionAppArmorProfile.generate(
            definition,
            ExecutionAppArmorMode.Pipe,
        );
        await removeGuardian(profile);
        try {
            await using first: ConnectorPrivateDirectory = await ConnectorPrivateDirectory.open(
                join(stateDirectory, ExecutionLane.First),
                ConnectorDirectoryPurpose.Execution,
            );
            await using second: ConnectorPrivateDirectory = await ConnectorPrivateDirectory.open(
                join(stateDirectory, ExecutionLane.Second),
                ConnectorDirectoryPurpose.Execution,
            );
            expect(first.directory).not.toBe(second.directory);
            await expect(ConnectorClientExecution.load(identity.identity)).rejects.toThrow(
                'exact enforcing command profiles are not installed',
            );
        } finally {
            await ExecutionAppArmorInstaller.installRequired(definition);
        }
        const lease: ReturnType<ExecutionIdentity['lease']> = identity.lease();
        const frames: ConnectorClientFrame[] = [];
        let closes: number = 0;
        const link: ExecutionDeliveryLink = {
            session: identity.session(lease),
            leaseId: lease.leaseId,
            send: (frame: ConnectorClientFrame): void => {
                frames.push(frame);
            },
            close: (): void => {
                closes++;
            },
        };
        {
            await using owner: ConnectorClientExecution = await ConnectorClientExecution.load(
                identity.identity,
            );
            const publications: readonly ExecutionPublication[] = owner.activate(link);
            expect(
                publications.map(
                    (publication: ExecutionPublication): ExecutionLane => publication.lane,
                ),
            ).toEqual(Object.values(ExecutionLane));
            expect(
                new Set(
                    publications.map(
                        (publication: ExecutionPublication): string => publication.journalId,
                    ),
                ).size,
            ).toBe(2);
            for (const publication of publications) {
                expect(publication.profile.programs[0]?.arguments).toEqual([rule]);
                expect(
                    SigningKey.verify(
                        SignaturePurpose.ExecutionProfile,
                        identity.device.publicKey,
                        ExecutionProof.publication(publication),
                        publication.signature,
                    ),
                ).toBe(true);
                expect(publication.leaseId).toBe(lease.leaseId);
            }
            expect(owner.workspaceSource.quiescent).toBe(true);
            expect(owner.failed).toBe(false);
            owner.detach(link);
        }
        await ExecutionPairPreparation.prepare(identity.identity, false);
        const after: readonly Buffer[] = await Promise.all(
            Object.values(ExecutionLane).map((lane: ExecutionLane): Promise<Buffer> =>
                readFile(join(stateDirectory, lane, 'execution-journal')),
            ),
        );
        expect(after).toEqual(before);
        expect(frames).toEqual([]);
        expect(closes).toBe(0);
        expect(await readdir(fixture.native.workspace)).toEqual(workspace);
        expect(
            (await readdir(fixture.native.delegation)).some((name: string): boolean =>
                name.startsWith('exec-'),
            ),
        ).toBe(false);
    },
    30000,
);
