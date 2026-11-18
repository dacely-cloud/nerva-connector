// SPDX-FileCopyrightText: 2026 Nerva contributors
// SPDX-License-Identifier: LicenseRef-Proprietary

import { expect, it, vi, type MockInstance } from 'vitest';
import type { HostWorkspace } from '../src/host/HostWorkspace.js';
import type { HostJsonObject } from '../src/host/HostMcpProtocol.js';
import { HostMcpWorkspaceTools } from '../src/host/HostMcpWorkspaceTools.js';
import { ConnectorHostFailure } from '../src/runtime/ConnectorHostFailure.js';
import { ConnectorHostTool } from 'nerva-connector-protocol/protocol/ConnectorHost.js';
import { HostWorkspaceFixture } from './support/HostWorkspaceFixture.js';

it.each<HostJsonObject>([
    { executable: 'calc.exe' },
    { executable: 'calc.exe', timeoutMs: 0 },
    { executable: 'calc.exe', timeoutMs: -1 },
    { executable: 'calc.exe', timeoutMs: '30000' },
    { executable: 'calc.exe', timeoutMs: 604800001 },
    { executable: 'calc.exe', timeoutMs: 30000, unexpected: 'field' },
    { executable: 'calc.exe', shell: 'cmd', command: 'start calc.exe', timeoutMs: 30000 },
    { executable: 'calc.exe', arguments: [false], timeoutMs: 30000 },
    { executable: 'calc.exe', arguments: ['bad\0argument'], timeoutMs: 30000 },
    { executable: 'calc.exe', environment: { 'INVALID=NAME': 'value' }, timeoutMs: 30000 },
    { executable: 'calc.exe', environment: { KEY: 5 }, timeoutMs: 30000 },
    { shell: 'not-a-supported-shell', command: 'echo marker', timeoutMs: 30000 },
])(
    'invalid launch arguments produce a definitive rejection before the host start boundary',
    async (args: HostJsonObject): Promise<void> => {
        await using fixture: HostWorkspaceFixture = await HostWorkspaceFixture.create();
        const start: MockInstance<HostWorkspace['start']> = vi.spyOn(fixture.host, 'start');
        try {
            const tools: HostMcpWorkspaceTools = new HostMcpWorkspaceTools(
                fixture.host,
                new AbortController().signal,
            );
            let failure: unknown;
            try {
                await tools.call('process_start', args);
            } catch (caught: unknown) {
                failure = caught;
            }
            expect(failure).toMatchObject({ code: 'invalid-request', definitive: true });
            expect(ConnectorHostFailure.response(ConnectorHostTool.ProcessStart, failure)).toEqual({
                outcome: 'failed',
                resultJson: null,
                errorCode: 'invalid-request',
            });
            expect(start).not.toHaveBeenCalled();
            expect(fixture.checks).toEqual([]);
        } finally {
            start.mockRestore();
        }
    },
);

it('a failure after invoking the operation owner retains uncertainty rather than borrowing pre-effect validation proof', async (): Promise<void> => {
    await using fixture: HostWorkspaceFixture = await HostWorkspaceFixture.create();
    const native: NodeJS.ErrnoException = new Error('Private native details');
    native.code = 'ENOENT';
    const start: MockInstance<HostWorkspace['start']> = vi
        .spyOn(fixture.host, 'start')
        .mockRejectedValue(native);
    try {
        const tools: HostMcpWorkspaceTools = new HostMcpWorkspaceTools(
            fixture.host,
            new AbortController().signal,
        );
        let failure: unknown;
        try {
            await tools.call('process_start', { executable: 'calc.exe', timeoutMs: 30000 });
        } catch (caught: unknown) {
            failure = caught;
        }
        expect(failure).toBe(native);
        expect(start).toHaveBeenCalledTimes(1);
        expect(start).toHaveBeenCalledWith(
            {
                executable: 'calc.exe',
                arguments: [],
                shell: null,
                command: null,
                directory: null,
                environment: {},
                timeoutMs: 30000,
            },
            65536,
            undefined,
        );
        expect(ConnectorHostFailure.response(ConnectorHostTool.ProcessStart, failure)).toEqual({
            outcome: 'indeterminate',
            resultJson: null,
            errorCode: 'not-found',
        });
    } finally {
        start.mockRestore();
    }
});
