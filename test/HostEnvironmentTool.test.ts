// SPDX-FileCopyrightText: 2026 Dacely <business@dacely.com>
// SPDX-License-Identifier: LicenseRef-Proprietary

import { delimiter } from 'node:path';
import { PassThrough } from 'node:stream';
import { expect, it, vi } from 'vitest';
import { HostMcpServer } from '../src/host/HostMcpServer.js';
import { HostMcpWorkspaceTools } from '../src/host/HostMcpWorkspaceTools.js';
import {
    HostMcpProtocol,
    type HostJsonObject,
    type HostMcpTool,
} from '../src/host/HostMcpProtocol.js';
import { HostOperation } from '../src/host/HostWorkspaceTypes.js';
import { ConnectorHostFailure } from '../src/runtime/ConnectorHostFailure.js';
import {
    ConnectorHostErrorCode,
    ConnectorHostTool,
} from 'nerva-connector-protocol/protocol/ConnectorHost.js';
import { HostEnvironmentFixture } from './support/HostEnvironmentFixture.js';
import { HostWorkspaceFixture } from './support/HostWorkspaceFixture.js';

/** Test-owned names cannot collide with programs or variables of the developer or CI machine. */
const program: string = 'nerva-environment-tool-probe';
const absent: string = 'nerva-environment-tool-absent-0f3a9c';

/** Prepend one owned executable directory and owned variables to the connector runtime environment. */
async function stub(environment: HostEnvironmentFixture): Promise<void> {
    const bin: string = await environment.directory('bin');
    await environment.file(bin, program, 0o755);
    vi.stubEnv('PATH', bin + delimiter + (process.env['PATH'] ?? ''));
    vi.stubEnv('NERVA_ENVIRONMENT_TOOL_PRESENT', 'value');
    vi.stubEnv('NERVA_ENVIRONMENT_TOOL_EMPTY', '');
}

/** Send newline-delimited frames through the real stdio server and parse every reply. */
async function exchange(
    tools: HostMcpWorkspaceTools,
    frames: readonly HostJsonObject[],
): Promise<readonly unknown[]> {
    const input: PassThrough = new PassThrough();
    const output: PassThrough = new PassThrough();
    const chunks: Buffer[] = [];
    output.on('data', (chunk: Buffer): void => {
        chunks.push(chunk);
    });
    const running: Promise<void> = new HostMcpServer(tools, input, output).run(
        new AbortController().signal,
    );
    input.end(
        frames.map((frame: HostJsonObject): string => JSON.stringify(frame)).join('\n') + '\n',
    );
    await running;
    return Buffer.concat(chunks)
        .toString('utf8')
        .trim()
        .split('\n')
        .map((line: string): unknown => JSON.parse(line));
}

it.skipIf(process.platform !== 'linux')(
    'stdio MCP lists environment_inspect and dispatches it through current workspace authority',
    async (): Promise<void> => {
        await using workspace: HostWorkspaceFixture = await HostWorkspaceFixture.create();
        await using environment: HostEnvironmentFixture = await HostEnvironmentFixture.create();
        try {
            await stub(environment);
            const tools: HostMcpWorkspaceTools = new HostMcpWorkspaceTools(
                workspace.host,
                new AbortController().signal,
            );
            const definition: HostMcpTool | undefined = tools.tools.find(
                (tool: HostMcpTool): boolean => tool.name === 'environment_inspect',
            );
            expect(definition?.inputSchema).toMatchObject({
                type: 'object',
                required: ['programs', 'variables'],
                additionalProperties: false,
                properties: {
                    programs: { type: 'array', maxItems: 256, uniqueItems: true },
                    variables: { type: 'array', maxItems: 256, uniqueItems: true },
                },
            });
            const replies: readonly unknown[] = await exchange(tools, [
                {
                    jsonrpc: '2.0',
                    id: 1,
                    method: 'initialize',
                    params: {
                        protocolVersion: HostMcpProtocol.version,
                        capabilities: {},
                        clientInfo: { name: 'test', version: '1' },
                    },
                },
                { jsonrpc: '2.0', method: 'notifications/initialized' },
                { jsonrpc: '2.0', id: 2, method: 'tools/list' },
                {
                    jsonrpc: '2.0',
                    id: 3,
                    method: 'tools/call',
                    params: {
                        name: 'environment_inspect',
                        arguments: {
                            programs: [program, absent, 'sh'],
                            variables: [
                                'NERVA_ENVIRONMENT_TOOL_PRESENT',
                                'NERVA_ENVIRONMENT_TOOL_EMPTY',
                                'NERVA_ENVIRONMENT_TOOL_ABSENT',
                                'PATH',
                            ],
                        },
                    },
                },
                {
                    jsonrpc: '2.0',
                    id: 4,
                    method: 'tools/call',
                    params: {
                        name: 'environment_inspect',
                        arguments: { programs: ['bin/' + program], variables: [] },
                    },
                },
            ]);
            expect(replies[1]).toEqual({ jsonrpc: '2.0', id: 2, result: { tools: tools.tools } });
            expect(replies[2]).toEqual({
                jsonrpc: '2.0',
                id: 3,
                result: {
                    content: [
                        {
                            type: 'text',
                            text: JSON.stringify({
                                platform: 'linux',
                                programs: [true, false, true],
                                variables: [true, false, false, true],
                            }),
                        },
                    ],
                    isError: false,
                },
            });
            expect(replies[3]).toMatchObject({ id: 4, result: { isError: true } });
            expect(JSON.stringify(replies)).not.toContain(environment.root);
            expect(workspace.checks).toEqual([
                {
                    operation: HostOperation.EnvironmentInspect,
                    path: null,
                    destinationPath: null,
                    processId: null,
                },
            ]);
            workspace.allowed = false;
            await expect(
                tools.call('environment_inspect', { programs: [program], variables: [] }),
            ).rejects.toThrow('revoked');
        } finally {
            vi.unstubAllEnvs();
        }
    },
);

it.each<HostJsonObject>([
    {},
    { programs: ['node'] },
    { variables: ['PATH'] },
    { programs: ['node'], variables: ['PATH'], extra: true },
    { programs: 'node', variables: [] },
    { programs: [], variables: { PATH: true } },
    { programs: [null], variables: [] },
    { programs: [''], variables: [] },
    { programs: ['.'], variables: [] },
    { programs: ['..'], variables: [] },
    { programs: ['a/b'], variables: [] },
    { programs: ['a\\b'], variables: [] },
    { programs: ['a\0b'], variables: [] },
    { programs: ['node', 'node'], variables: [] },
    { programs: ['n'.repeat(256)], variables: [] },
    {
        programs: Array.from({ length: 257 }, (_value: unknown, index: number): string =>
            String(index),
        ),
        variables: [],
    },
    { programs: [], variables: ['A=B'] },
    { programs: [], variables: [''] },
    { programs: [], variables: ['PATH', 'PATH'] },
])(
    'invalid environment_inspect arguments are a definitive invalid request before authorization',
    async (args: HostJsonObject): Promise<void> => {
        await using workspace: HostWorkspaceFixture = await HostWorkspaceFixture.create();
        const tools: HostMcpWorkspaceTools = new HostMcpWorkspaceTools(
            workspace.host,
            new AbortController().signal,
        );
        let caught: unknown;
        try {
            await tools.call('environment_inspect', args);
        } catch (error: unknown) {
            caught = error;
        }
        expect(caught).toMatchObject({
            code: ConnectorHostErrorCode.InvalidRequest,
            definitive: true,
        });
        expect(ConnectorHostFailure.response(ConnectorHostTool.EnvironmentInspect, caught)).toEqual(
            {
                outcome: 'failed',
                resultJson: null,
                errorCode: 'invalid-request',
            },
        );
        expect(workspace.checks).toEqual([]);
    },
);

it('environment inspection failures after admission remain definitive observations', (): void => {
    const native: NodeJS.ErrnoException = new Error('Private native details');
    native.code = 'EIO';
    expect(ConnectorHostFailure.response(ConnectorHostTool.EnvironmentInspect, native)).toEqual({
        outcome: 'failed',
        resultJson: null,
        errorCode: 'operation-failed',
    });
});
