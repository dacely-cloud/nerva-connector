// SPDX-FileCopyrightText: 2026 Dacely <business@dacely.com>
// SPDX-License-Identifier: LicenseRef-Proprietary

import { stat } from 'node:fs/promises';
import { join } from 'node:path';
import { expect, it, vi, type MockInstance } from 'vitest';
import {
    ConnectorHostTool,
    type ConnectorHostResponse,
} from 'nerva-connector-protocol/protocol/ConnectorHost.js';
import type { HostWorkspace } from '../src/host/HostWorkspace.js';
import type { HostJsonObject } from '../src/host/HostMcpProtocol.js';
import { HostMcpWorkspaceTools } from '../src/host/HostMcpWorkspaceTools.js';
import { ConnectorHostFailure } from '../src/runtime/ConnectorHostFailure.js';
import { HostWorkspaceFixture } from './support/HostWorkspaceFixture.js';

/** One argument-contract refusal: the tool, its arguments and the local message that names the field. */
interface ShapeCase {
    readonly tool: ConnectorHostTool;
    readonly args: HostJsonObject;
    readonly message: string;
}

it.each<ShapeCase>([
    {
        tool: ConnectorHostTool.ProcessRead,
        args: { processId: 'p', stdoutOffset: 0, stderrOffset: '0' },
        message: 'stdoutOffset must be a decimal integer string such as "0", not a JSON number',
    },
    {
        tool: ConnectorHostTool.ProcessRead,
        args: { processId: 'p', stdoutOffset: '01' },
        message: 'stdoutOffset must be a decimal integer string such as "0"',
    },
    {
        tool: ConnectorHostTool.FileRead,
        args: { path: 'missing.txt', offset: '0', maximumBytes: '1024' },
        message: 'maximumBytes must be a JSON integer from 1 to 1048576, not a string',
    },
    {
        tool: ConnectorHostTool.FileWrite,
        args: { path: 'new.txt', data: 'x', encoding: 'utf8', mode: 'update', offset: 0 },
        message: 'offset must be a decimal integer string such as "0", not a JSON number',
    },
    {
        tool: ConnectorHostTool.FileWrite,
        args: { path: 'new.txt', data: 'x', encoding: 'utf-8', mode: 'replace' },
        message: 'encoding must be one of utf8, base64',
    },
    {
        tool: ConnectorHostTool.FileWrite,
        args: { path: 'new.txt', data: 'x', encoding: 'utf8', mode: 'overwrite' },
        message: 'mode must be one of create, replace, update, append',
    },
    {
        tool: ConnectorHostTool.FileWrite,
        args: { path: 'new.txt', data: 'not base64!', encoding: 'base64', mode: 'create' },
        message: 'data must be canonical padded base64 when encoding is base64',
    },
    {
        tool: ConnectorHostTool.FileWrite,
        args: { path: 'new.txt', data: 'x', encoding: 'utf8', mode: 'append', offset: '1' },
        message: 'an offset other than "0" needs mode update',
    },
    {
        tool: ConnectorHostTool.FileRemove,
        args: { path: 'new.txt', recursive: 'true' },
        message: 'recursive must be true or false, not a string',
    },
    {
        tool: ConnectorHostTool.FileRemove,
        args: { path: 'new.txt' },
        message: 'file_remove requires recursive',
    },
    {
        tool: ConnectorHostTool.FileRemove,
        args: { path: '', recursive: false },
        message: 'path must not be empty',
    },
    {
        tool: ConnectorHostTool.FileChmod,
        args: { path: 'new.txt', mode: 99999 },
        message: 'mode must be a JSON integer from 0 to 4095',
    },
    {
        tool: ConnectorHostTool.ProcessStart,
        args: { executable: 'private.exe', arguments: 'private argument', timeoutMs: 1000 },
        message: 'arguments must be an array of strings, not a string',
    },
    {
        tool: ConnectorHostTool.ProcessStart,
        args: { command: 'private command', timeoutMs: 1000 },
        message: 'process_start requires shell with command',
    },
    {
        tool: ConnectorHostTool.EnvironmentInspect,
        args: { programs: ['node'] },
        message: 'environment_inspect requires variables',
    },
])(
    'a wrong argument for $tool is a definitive invalid request naming the field',
    async ({ tool, args, message }: ShapeCase): Promise<void> => {
        await using fixture: HostWorkspaceFixture = await HostWorkspaceFixture.create();
        const tools: HostMcpWorkspaceTools = new HostMcpWorkspaceTools(
            fixture.host,
            new AbortController().signal,
        );
        let failure: unknown = null;
        try {
            await tools.call(tool, args);
        } catch (caught: unknown) {
            failure = caught;
        }
        expect(failure).toMatchObject({ code: 'invalid-request', definitive: true, message });
        expect(String(failure)).not.toContain('private');
        const response: ConnectorHostResponse = ConnectorHostFailure.response(tool, failure);
        expect(response).toEqual({
            outcome: 'failed',
            resultJson: null,
            errorCode: 'invalid-request',
        });
        expect(fixture.checks).toEqual([]);
        await expect(stat(join(fixture.directory, 'new.txt'))).rejects.toThrow();
    },
);

it('null stays an absent optional field, so a mode-exclusive launch still reaches the operation owner', async (): Promise<void> => {
    await using fixture: HostWorkspaceFixture = await HostWorkspaceFixture.create();
    const native: NodeJS.ErrnoException = new Error('Private native details');
    native.code = 'EACCES';
    const start: MockInstance<HostWorkspace['start']> = vi
        .spyOn(fixture.host, 'start')
        .mockRejectedValue(native);
    try {
        const tools: HostMcpWorkspaceTools = new HostMcpWorkspaceTools(
            fixture.host,
            new AbortController().signal,
        );
        await expect(
            tools.call('process_start', {
                executable: 'calc.exe',
                command: null,
                directory: null,
                shell: null,
                timeoutMs: 30000,
            }),
        ).rejects.toBe(native);
        expect(start).toHaveBeenCalledTimes(1);
        expect(ConnectorHostFailure.response(ConnectorHostTool.ProcessStart, native)).toEqual({
            outcome: 'indeterminate',
            resultJson: null,
            errorCode: 'permission-denied',
        });
    } finally {
        start.mockRestore();
    }
});
