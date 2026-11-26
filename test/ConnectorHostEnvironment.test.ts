// SPDX-FileCopyrightText: 2026 Dacely <business@dacely.com>
// SPDX-License-Identifier: LicenseRef-Proprietary

import { writeFile } from 'node:fs/promises';
import { delimiter, join } from 'node:path';
import { expect, it, vi } from 'vitest';
import { SignaturePurpose } from 'nerva-connector-protocol/identity/IdentityFormat.js';
import { ConnectorHostCodec } from 'nerva-connector-protocol/protocol/ConnectorHostCodec.js';
import {
    ConnectorHostTool,
    ConnectorHostOutcome,
    ConnectorHostErrorCode,
    type ConnectorHostPermit,
    type ConnectorHostCompletion,
} from 'nerva-connector-protocol/protocol/ConnectorHost.js';
import type { ConnectorClientHost } from '../src/runtime/ConnectorClientHost.js';
import { ConnectorHostGrant } from '../src/runtime/ConnectorHostGrant.js';
import { type ConnectorHostLocalGrant } from '../src/runtime/ConnectorHostGrantTypes.js';
import { ConnectorHostFixture } from './support/ConnectorHostFixture.js';
import { HostEnvironmentFixture } from './support/HostEnvironmentFixture.js';

/** Test-owned names cannot collide with programs or variables of the developer or CI machine. */
const program: string = 'nerva-paired-environment-probe';
const absent: string = 'nerva-paired-environment-absent-7c21d4';

it.skipIf(process.platform !== 'linux')(
    'signed environment inspection returns aligned flags, replays its original and rejects invalid names definitively',
    async (): Promise<void> => {
        await using fixture: ConnectorHostFixture = await ConnectorHostFixture.create();
        await using environment: HostEnvironmentFixture = await HostEnvironmentFixture.create();
        const grant: ConnectorHostLocalGrant = await fixture.grant();
        expect(grant.profile.tools).toContain(ConnectorHostTool.EnvironmentInspect);
        const host: ConnectorClientHost = await fixture.open();
        const bin: string = await environment.directory('bin');
        await environment.file(bin, program, 0o755);
        try {
            vi.stubEnv('PATH', bin + delimiter + (process.env['PATH'] ?? ''));
            vi.stubEnv('NERVA_PAIRED_ENVIRONMENT_PRESENT', 'secret-value');
            vi.stubEnv('NERVA_PAIRED_ENVIRONMENT_EMPTY', '');
            const inspecting: ConnectorHostPermit = fixture.permit(
                grant,
                1n,
                ConnectorHostTool.EnvironmentInspect,
                JSON.stringify({
                    programs: [absent, program],
                    variables: [
                        'NERVA_PAIRED_ENVIRONMENT_EMPTY',
                        'NERVA_PAIRED_ENVIRONMENT_PRESENT',
                        'NERVA_PAIRED_ENVIRONMENT_ABSENT',
                    ],
                }),
            );
            const inspected: ConnectorHostCompletion = await host.execute(
                inspecting,
                inspecting.leaseId,
                inspecting.expiresAtMs,
            );
            expect(inspected.response).toEqual({
                outcome: ConnectorHostOutcome.Succeeded,
                resultJson: JSON.stringify({
                    platform: 'linux',
                    programs: [false, true],
                    variables: [false, true, false],
                }),
                errorCode: null,
            });
            expect(inspected.response.resultJson).not.toContain('secret-value');
            expect(inspected.response.resultJson).not.toContain(bin);
            vi.stubEnv('NERVA_PAIRED_ENVIRONMENT_EMPTY', 'now-present');
            const replayed: ConnectorHostCompletion = await host.execute(
                inspecting,
                inspecting.leaseId,
                inspecting.expiresAtMs,
            );
            expect(replayed.response).toEqual(inspected.response);
            await host.acknowledge(fixture.acknowledgment(inspected), inspecting.leaseId);
            const invalid: ConnectorHostPermit = fixture.permit(
                grant,
                2n,
                ConnectorHostTool.EnvironmentInspect,
                JSON.stringify({ programs: ['bin/' + program], variables: [] }),
            );
            const rejected: ConnectorHostCompletion = await host.execute(
                invalid,
                invalid.leaseId,
                invalid.expiresAtMs,
            );
            expect(rejected.response).toEqual({
                outcome: ConnectorHostOutcome.Failed,
                resultJson: null,
                errorCode: ConnectorHostErrorCode.InvalidRequest,
            });
            await host.acknowledge(fixture.acknowledgment(rejected), invalid.leaseId);
        } finally {
            vi.unstubAllEnvs();
        }
    },
    30000,
);

it.skipIf(process.platform !== 'linux')(
    'an existing signed grant without environment_inspect does not gain the new tool',
    async (): Promise<void> => {
        await using fixture: ConnectorHostFixture = await ConnectorHostFixture.create();
        const installed: ConnectorHostLocalGrant = await fixture.grant();
        const body: Omit<ConnectorHostLocalGrant, 'signature'> = {
            authorityId: installed.authorityId,
            environmentId: installed.environmentId,
            enrollmentId: installed.enrollmentId,
            journalId: installed.journalId,
            journalInitialized: installed.journalInitialized,
            profile: {
                ...installed.profile,
                tools: installed.profile.tools.filter(
                    (tool: ConnectorHostTool): boolean =>
                        tool !== ConnectorHostTool.EnvironmentInspect,
                ),
            },
        };
        const legacy: ConnectorHostLocalGrant = {
            ...body,
            signature: fixture.peer.device.sign(
                SignaturePurpose.HostGrant,
                ConnectorHostGrant.payload(body),
            ),
        };
        await writeFile(
            join(ConnectorHostGrant.directory(fixture.identity), 'grant.json'),
            ConnectorHostCodec.encode(legacy),
            { mode: 0o600 },
        );
        const host: ConnectorClientHost = await fixture.open();
        expect(host.grant.profile.tools).not.toContain(ConnectorHostTool.EnvironmentInspect);
        const permit: ConnectorHostPermit = fixture.permit(
            legacy,
            1n,
            ConnectorHostTool.EnvironmentInspect,
            JSON.stringify({ programs: ['sh'], variables: ['PATH'] }),
        );
        const completion: ConnectorHostCompletion = await host.execute(
            permit,
            permit.leaseId,
            permit.expiresAtMs,
        );
        expect(completion.response).toEqual({
            outcome: ConnectorHostOutcome.Failed,
            resultJson: null,
            errorCode: ConnectorHostErrorCode.AdmissionDenied,
        });
    },
    30000,
);
