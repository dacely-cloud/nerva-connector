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

/** One argument-shape refusal: the tool, its arguments and the local message that names the field. */
interface ShapeCase {
    readonly tool: ConnectorHostTool;
    readonly args: HostJsonObject;
    readonly message: string;
}

const offset: string = '^(0|[1-9][0-9]{0,18})$';

it.each<ShapeCase>([
    {
        tool: ConnectorHostTool.ProcessRead,
        args: { processId: 'p', stdoutOffset: 0, stderrOffset: '0' },
        message: `Host operation field stdoutOffset must be a string matching ${offset}, not an integer`,
    },
    {
        tool: ConnectorHostTool.FileRead,
        args: { path: 'missing.txt', offset: '0', maximumBytes: '1024' },
        message: 'Host operation field maximumBytes must be an integer, not a string',
    },
    {
        tool: ConnectorHostTool.FileWrite,
        args: { path: 'new.txt', data: 'x', encoding: 'utf8', mode: 'update', offset: 0 },
        message: `Host operation field offset must be a string matching ${offset}, not an integer`,
    },
    {
        tool: ConnectorHostTool.FileWrite,
        args: { path: 'new.txt', data: 'x', encoding: 'utf-8', mode: 'replace' },
        message: 'Host operation field encoding must be one of "utf8", "base64"',
    },
    {
        tool: ConnectorHostTool.FileWrite,
        args: { path: 'new.txt', data: 'x', encoding: 'utf8', mode: 'overwrite' },
        message: 'Host operation field mode must be one of "create", "replace", "update", "append"',
    },
    {
        tool: ConnectorHostTool.FileRemove,
        args: { path: 'new.txt', recursive: 'true' },
        message: 'Host operation field recursive must be a boolean, not a string',
    },
    {
        tool: ConnectorHostTool.FileChmod,
        args: { path: 'new.txt', mode: 99999 },
        message: 'Host operation field mode must be from 0 to 4095',
    },
    {
        tool: ConnectorHostTool.ProcessStart,
        args: { executable: 'private.exe', arguments: 'private argument', timeoutMs: 1000 },
        message: 'Host operation field arguments must be an array, not a string',
    },
])(
    'a wrong JSON shape for $tool is a definitive invalid request naming the field',
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

it.each<ShapeCase>([
    {
        tool: ConnectorHostTool.ProcessRead,
        args: { processId: 'p', stdoutOffset: '01' },
        message: 'Host operation offsets must be decimal strings within the signed 64-bit range',
    },
    {
        tool: ConnectorHostTool.FileWrite,
        args: { path: 'new.txt', data: 'not base64!', encoding: 'base64', mode: 'create' },
        message: 'Host operation data must be canonical base64 within the transport chunk bound',
    },
    {
        tool: ConnectorHostTool.FileRemove,
        args: { path: '', recursive: false },
        message: 'Host operation text must be a string without NUL characters and not empty',
    },
])(
    'a decoder refusal for $tool after the shape check is still definitive',
    async ({ tool, args, message }: ShapeCase): Promise<void> => {
        await using fixture: HostWorkspaceFixture = await HostWorkspaceFixture.create();
        const tools: HostMcpWorkspaceTools = new HostMcpWorkspaceTools(
            fixture.host,
            new AbortController().signal,
        );
        await expect(tools.call(tool, args)).rejects.toMatchObject({
            code: 'invalid-request',
            definitive: true,
            message,
        });
        expect(fixture.checks).toEqual([]);
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
