// SPDX-FileCopyrightText: 2026 Dacely <business@dacely.com>
// SPDX-License-Identifier: LicenseRef-Proprietary

import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import type { ExecutionFixture } from './ExecutionFixture.js';
import type { ExecutionClientSettings } from '../../src/execution/ExecutionClientSettings.js';
import { ExecutionPolicyCodec } from '../../src/execution/ExecutionPolicyCodec.js';
import { type ExecutionPolicyDefinition } from 'nerva-connector-protocol/execution/ExecutionPolicyTypes.js';
import { ExecutionArgumentKind } from 'nerva-connector-protocol/execution/ExecutionArgumentKind.js';
import { ExecutionWorkspaceAccess } from 'nerva-connector-protocol/execution/ExecutionTypes.js';
import { ExecutionLane } from 'nerva-connector-protocol/execution/ExecutionLane.js';

/** Only this test-owned operator policy grants the finite effect and hold probes. */
export async function setup(fixture: ExecutionFixture): Promise<ExecutionClientSettings> {
    const path: string = await fixture.policy(
        fixture.helperFile,
        ExecutionWorkspaceAccess.ReadWrite,
    );
    const raw: unknown = JSON.parse(await readFile(path, 'utf8'));
    const original: ExecutionPolicyDefinition = ExecutionPolicyCodec.policy(raw);
    const definition: ExecutionPolicyDefinition = {
        ...original,
        programs: original.programs.map((program): (typeof original.programs)[number] => ({
            ...program,
            arguments: [
                {
                    kind: ExecutionArgumentKind.Choice,
                    values: [
                        'effect',
                        'effect-hold',
                        'output-hold',
                        'read-write',
                        'hold-a',
                        'hold-b',
                    ],
                },
            ],
        })),
    };
    await writeFile(
        path,
        JSON.stringify(definition, (_key: string, value: unknown): unknown =>
            typeof value === 'bigint' ? value.toString() : value,
        ),
        { mode: 0o600 },
    );
    await fixture.installProfile(definition);
    const stateDirectory: string = join(fixture.directory, 'execution-state');
    await mkdir(stateDirectory, { mode: 0o700 });
    return { lane: ExecutionLane.First, policyFile: path, stateDirectory };
}
