// SPDX-FileCopyrightText: 2026 Nerva contributors
// SPDX-License-Identifier: LicenseRef-Proprietary

import { expect, it } from 'vitest';
import { JointWorkspaceFixture } from './support/JointWorkspaceFixture.js';
import { ExecutionMachineFixture } from './support/ExecutionMachineFixture.js';
import {
    JointWorkspaceAssembly,
    type JointWorkspaceSources,
} from '../src/workspace/JointWorkspaceAssembly.js';
import { JointWorkspaceProof } from '../src/workspace/JointWorkspaceProof.js';
import { JointWorkspaceCodec } from 'nerva-connector-protocol/workspace/JointWorkspaceCodec.js';
import type { JointWorkspaceDescriptor } from 'nerva-connector-protocol/workspace/JointWorkspaceBinding.js';
import { ConnectorFileMode } from 'nerva-connector-protocol/protocol/ConnectorFiles.js';
import { ExecutionArgumentKind } from 'nerva-connector-protocol/execution/ExecutionArgumentKind.js';
import { ExecutionInteractiveTransport } from 'nerva-connector-protocol/execution/ExecutionInteractive.js';
import { ExecutionInputKind } from 'nerva-connector-protocol/execution/ExecutionInput.js';
import type { ExecutionInteractiveInvocationRule } from 'nerva-connector-protocol/execution/ExecutionInteractiveInvocation.js';
import { ExecutionJobsCodec } from '../src/execution/ExecutionJobsCodec.js';
import type { ExecutionProfile } from '../src/execution/ExecutionJobs.js';

/** These real signatures qualify assembly/counter handling over synthetic captures, not native execution or publication. */
class InteractiveAssemblyFixture {
    public static readonly revision: bigint = 9223372036854775807n;

    public static sources(
        fixture: JointWorkspaceFixture,
        access: ConnectorFileMode,
        maximumInputBytes: bigint = 65536n,
    ): JointWorkspaceSources {
        const sources: JointWorkspaceSources = fixture.sources(access);
        const rule: ExecutionInteractiveInvocationRule = {
            kind: ExecutionArgumentKind.InteractiveInvocation,
            invocation: ExecutionMachineFixture.rule(),
            transports: [ExecutionInteractiveTransport.Pipe],
            controls: [ExecutionInputKind.Data, ExecutionInputKind.End],
            maximumInputBytes,
            maximumControls: 256,
            maximumResizes: 0,
        };
        return {
            ...sources,
            fileProfile: { ...sources.fileProfile, revision: this.revision },
            executionProfile: {
                ...sources.executionProfile,
                revision: this.revision,
                timeoutMs: 5000,
                programs: [{ id: 'pipe', rootIds: [sources.execution.rootId], arguments: [rule] }],
            },
        };
    }
}

it.each([ConnectorFileMode.ReadOnly, ConnectorFileMode.ReadWrite])(
    'genuine Joint assembly accepts nested Pipe counters and exact int64 revisions for %s',
    (access: ConnectorFileMode): void => {
        using fixture: JointWorkspaceFixture = new JointWorkspaceFixture();
        const sources: JointWorkspaceSources = InteractiveAssemblyFixture.sources(fixture, access);
        const descriptor: JointWorkspaceDescriptor = JointWorkspaceAssembly.create(
            fixture.device,
            fixture.scope,
            InteractiveAssemblyFixture.revision,
            sources,
        );
        expect(JointWorkspaceProof.verify(fixture.expected, descriptor)).toBe(true);
        expect(
            JointWorkspaceProof.verify(
                { ...fixture.expected, environmentId: 'other-environment' },
                descriptor,
            ),
        ).toBe(false);
        expect(descriptor.binding.revision).toBe(InteractiveAssemblyFixture.revision);
        expect(descriptor.binding.fileRootId).toBe(sources.file.rootId);
        expect(descriptor.binding.executionRootId).toBe(sources.execution.rootId);
        expect(descriptor.binding.access).toBe(access);
        expect(descriptor.binding.executionPolicySha256).toBe(
            sources.executionProfile.policySha256,
        );
        expect(JointWorkspaceCodec.decode(JointWorkspaceCodec.encode(descriptor))).toEqual(
            descriptor,
        );
        const wire: unknown = JSON.parse(ExecutionJobsCodec.encode(sources.executionProfile));
        const decoded: ExecutionProfile = ExecutionJobsCodec.profile(wire);
        expect(decoded).toEqual(sources.executionProfile);
        expect(sources.executionProfile.revision).toBe(InteractiveAssemblyFixture.revision);
        const rule: ExecutionProfile['programs'][number]['arguments'][number] | undefined =
            sources.executionProfile.programs[0]?.arguments[0];
        if (rule === undefined || rule.kind !== ExecutionArgumentKind.InteractiveInvocation) {
            throw new Error('The exact nested Pipe grant must remain present');
        }
        expect(rule.maximumInputBytes).toBe(65536n);
    },
);

it.each([-1n, 65537n, 9223372036854775807n])(
    'Joint assembly refuses invalid nested input ceiling %s before signing',
    (maximumInputBytes: bigint): void => {
        using fixture: JointWorkspaceFixture = new JointWorkspaceFixture();
        const sources: JointWorkspaceSources = InteractiveAssemblyFixture.sources(
            fixture,
            ConnectorFileMode.ReadWrite,
            maximumInputBytes,
        );
        expect((): JointWorkspaceDescriptor =>
            JointWorkspaceAssembly.create(fixture.device, fixture.scope, 1n, sources),
        ).toThrow();
    },
);

it('foreground sources retain exact revisions and complete source validation', (): void => {
    using fixture: JointWorkspaceFixture = new JointWorkspaceFixture();
    const sources: JointWorkspaceSources = fixture.sources();
    const descriptor: JointWorkspaceDescriptor = JointWorkspaceAssembly.create(
        fixture.device,
        fixture.scope,
        InteractiveAssemblyFixture.revision,
        {
            ...sources,
            executionProfile: {
                ...sources.executionProfile,
                revision: InteractiveAssemblyFixture.revision,
            },
        },
    );
    expect(JointWorkspaceProof.verify(fixture.expected, descriptor)).toBe(true);
    expect((): JointWorkspaceDescriptor =>
        JointWorkspaceAssembly.create(fixture.device, fixture.scope, 1n, {
            ...sources,
            executionProfile: {
                ...sources.executionProfile,
                revision: InteractiveAssemblyFixture.revision + 1n,
            },
        }),
    ).toThrow();
});
