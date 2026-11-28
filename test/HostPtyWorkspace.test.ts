// SPDX-FileCopyrightText: 2026 Dacely <business@dacely.com>
// SPDX-License-Identifier: LicenseRef-Proprietary

import { existsSync } from 'node:fs';
import { setTimeout as delay } from 'node:timers/promises';
import { afterEach, expect, it, vi } from 'vitest';
import { HostLinuxBuild } from '../src/host/HostLinuxBuild.js';
import { HostMcpWorkspaceTools } from '../src/host/HostMcpWorkspaceTools.js';
import { HostTerminal } from '../src/host/HostTerminal.js';
import type { HostTerminalRequest, HostTerminalSnapshot } from '../src/host/HostTerminalTypes.js';
import { Boundary } from 'nerva-connector-protocol/protocol/Boundary.js';
import { ConnectorHostTool } from 'nerva-connector-protocol/protocol/ConnectorHost.js';
import { ConnectorHostFailure } from '../src/runtime/ConnectorHostFailure.js';
import { HostWorkspaceFixture } from './support/HostWorkspaceFixture.js';

const native: boolean = process.platform === 'linux' && existsSync(HostLinuxBuild.executable());

afterEach((): void => {
    vi.restoreAllMocks();
});

/** The fixture program is passed directly to Python without creating scripts or caches. */
function request(source: string = 'pass'): HostTerminalRequest {
    return {
        executable: '/usr/bin/python3',
        arguments: ['-I', '-B', '-c', source],
        shell: null,
        command: null,
        directory: null,
        environment: {},
        timeoutMs: 10000,
        cols: 80,
        rows: 24,
    };
}

/** Polling reads only the already admitted original owner. */
async function output(
    fixture: HostWorkspaceFixture,
    id: string,
    complete: boolean,
): Promise<HostTerminalSnapshot> {
    for (let attempt: number = 0; attempt < 1000; attempt++) {
        const result: HostTerminalSnapshot = await fixture.host.terminals.output(id, 0n, 32768);
        if (complete ? result.outputComplete : result.output.bytes.includes(Buffer.from('READY'))) {
            return result;
        }
        await delay(5);
    }
    throw new Error('Terminal fixture did not reach its expected state');
}

it('terminal discovery requires completed native evidence and a revoked probe can be retried', async (): Promise<void> => {
    await using fixture: HostWorkspaceFixture = await HostWorkspaceFixture.create();
    const probe = vi.spyOn(HostTerminal, 'available').mockResolvedValue(true);
    const tools: HostMcpWorkspaceTools = new HostMcpWorkspaceTools(
        fixture.host,
        new AbortController().signal,
    );
    expect(tools.tools.some((tool): boolean => tool.name.startsWith('terminal_'))).toBe(false);
    await expect(tools.call('terminal_start', {})).rejects.toMatchObject({
        code: 'unsupported',
        definitive: true,
    });
    fixture.allowed = false;
    await expect(fixture.host.terminals.available()).rejects.toThrow('revoked');
    expect(probe).not.toHaveBeenCalled();
    fixture.allowed = true;
    expect(await fixture.host.terminals.available()).toBe(true);
    expect(await fixture.host.terminals.available()).toBe(true);
    expect(probe).toHaveBeenCalledTimes(1);
    expect(fixture.host.terminals.supported).toBe(true);
});

it.skipIf(process.platform === 'win32')(
    'a terminal refused before its native broker is spawned is a definitive failure, not an uncertain start',
    async (): Promise<void> => {
        await using fixture: HostWorkspaceFixture = await HostWorkspaceFixture.create();
        vi.spyOn(HostTerminal, 'available').mockResolvedValue(true);
        vi.spyOn(HostLinuxBuild, 'read').mockResolvedValue(null);
        let failure: unknown = null;
        try {
            await fixture.host.terminals.start(request());
        } catch (caught: unknown) {
            failure = caught;
        }
        expect(failure).toMatchObject({
            code: 'unsupported',
            definitive: true,
            message: 'Host terminals require their reviewed native build',
        });
        expect(ConnectorHostFailure.response(ConnectorHostTool.TerminalStart, failure)).toEqual({
            outcome: 'failed',
            resultJson: null,
            errorCode: 'unsupported',
        });
        expect(fixture.host.terminals.size).toBe(0);
    },
);

it('a closed workspace refuses a terminal start definitively before anything is created', async (): Promise<void> => {
    const fixture: HostWorkspaceFixture = await HostWorkspaceFixture.create();
    vi.spyOn(HostTerminal, 'available').mockResolvedValue(true);
    const create = vi.spyOn(HostTerminal, 'create');
    await fixture[Symbol.asyncDispose]();
    await expect(fixture.host.terminals.start(request())).rejects.toMatchObject({
        code: 'canceled',
        definitive: true,
    });
    expect(create).not.toHaveBeenCalled();
});

it.skipIf(!native)(
    'MCP terminal tools preserve binary input, exact EOF and operation-boundary revocation',
    async (): Promise<void> => {
        await using fixture: HostWorkspaceFixture = await HostWorkspaceFixture.create();
        const tools: HostMcpWorkspaceTools = new HostMcpWorkspaceTools(
            fixture.host,
            new AbortController().signal,
            undefined,
            await fixture.host.terminals.available(),
        );
        expect(
            tools.tools.filter((tool): boolean => tool.name.startsWith('terminal_')),
        ).toHaveLength(6);
        const started: unknown = JSON.parse(
            await tools.call('terminal_start', {
                executable: '/usr/bin/python3',
                arguments: [
                    '-I',
                    '-B',
                    '-c',
                    "import os,tty\ntty.setraw(0)\nos.write(1,b'READY')\ndata=os.read(0,3)\nos.write(1,data)\nos._exit(7)",
                ],
                timeoutMs: 10000,
                cols: 80,
                rows: 24,
            }),
        );
        const id: string = Boundary.id(
            Boundary.record(started, [
                'processId',
                'running',
                'treeRunning',
                'cols',
                'rows',
                'outputComplete',
                'finalOutputBytes',
                'exitCode',
                'signal',
                'failure',
                'output',
            ])['processId'],
        );
        await output(fixture, id, false);
        fixture.allowed = false;
        await expect(
            tools.call('terminal_resize', { processId: id, cols: 112, rows: 37 }),
        ).rejects.toThrow('revoked');
        await expect(
            tools.call('terminal_write', { processId: id, encoding: 'base64', data: 'AP8K' }),
        ).rejects.toThrow('revoked');
        await expect(tools.call('terminal_read', { processId: id })).rejects.toThrow('revoked');
        fixture.allowed = true;
        await expect(
            tools.call('terminal_resize', { processId: id, cols: 1, rows: 37 }),
        ).rejects.toMatchObject({ code: 'invalid-request', definitive: true });
        await tools.call('terminal_resize', { processId: id, cols: 112, rows: 37 });
        await tools.call('terminal_write', { processId: id, encoding: 'base64', data: 'AP8K' });
        const finished: HostTerminalSnapshot = await output(fixture, id, true);
        expect(finished.output.bytes).toEqual(
            Buffer.concat([Buffer.from('READY'), Buffer.from([0, 255, 10])]),
        );
        expect(finished.exitCode).toBe(7);
        expect(finished.cols).toBe(112);
        const read: unknown = JSON.parse(await tools.call('terminal_read', { processId: id }));
        expect(read).toMatchObject({
            outputComplete: true,
            finalOutputBytes: '8',
            output: {
                encoding: 'base64',
                data: Buffer.from([82, 69, 65, 68, 89, 0, 255, 10]).toString('base64'),
            },
        });
        await tools.call('terminal_release', { processId: id });
        expect(fixture.host.terminals.size).toBe(0);
        await expect(fixture.host.terminals.output(id, 0n, 1)).rejects.toMatchObject({
            code: 'not-found',
            definitive: true,
        });
    },
);

it.skipIf(!native)(
    'terminal cells and ordinary processes stay retained in any number until release',
    async (): Promise<void> => {
        await using fixture: HostWorkspaceFixture = await HostWorkspaceFixture.create();
        const terminals: HostTerminalSnapshot[] = [];
        for (let index: number = 0; index < 40; index++) {
            terminals.push(await fixture.host.terminals.start(request()));
        }
        const ordinary: Awaited<ReturnType<typeof fixture.host.start>> =
            await fixture.host.start(request());
        expect(fixture.host.terminals.size).toBe(40);
        expect(
            new Set(terminals.map((terminal: HostTerminalSnapshot): string => terminal.processId))
                .size,
        ).toBe(40);
        for (const terminal of terminals) {
            await fixture.host.terminals.release(terminal.processId);
        }
        await fixture.host.release(ordinary.processId);
        expect(fixture.host.terminals.size).toBe(0);
    },
    60000,
);

it.skipIf(!native)(
    'failed terminal admission retains an unconfirmed native owner for later joined cleanup',
    async (): Promise<void> => {
        await using fixture: HostWorkspaceFixture = await HostWorkspaceFixture.create();
        const original: typeof HostTerminal.create = HostTerminal.create.bind(HostTerminal);
        let captured: HostTerminal | null = null;
        vi.spyOn(HostTerminal, 'create').mockImplementation(
            async (...args: Parameters<typeof HostTerminal.create>): Promise<HostTerminal> => {
                const terminal: HostTerminal = await original(...args);
                captured = terminal;
                vi.spyOn(terminal, Symbol.asyncDispose).mockRejectedValueOnce(
                    new Error('unconfirmed native shutdown'),
                );
                throw new Error('injected late startup failure');
            },
        );
        await expect(
            fixture.host.terminals.start(request('import time;time.sleep(30)')),
        ).rejects.toThrow('owned cleanup are unconfirmed');
        expect(captured).not.toBeNull();
        expect(fixture.host.terminals.size).toBe(1);
        await fixture.host[Symbol.asyncDispose]();
        expect(fixture.host.terminals.size).toBe(0);
    },
);

it.skipIf(!native)(
    'workspace shutdown joins terminal owners registered after its initial cleanup capture',
    async (): Promise<void> => {
        await using fixture: HostWorkspaceFixture = await HostWorkspaceFixture.create();
        const original: typeof HostTerminal.create = HostTerminal.create.bind(HostTerminal);
        const entered: PromiseWithResolvers<undefined> = Promise.withResolvers<undefined>();
        const proceed: PromiseWithResolvers<undefined> = Promise.withResolvers<undefined>();
        vi.spyOn(HostTerminal, 'create').mockImplementation(
            async (...args: Parameters<typeof HostTerminal.create>): Promise<HostTerminal> => {
                entered.resolve(undefined);
                await proceed.promise;
                const terminal: HostTerminal = await original(...args);
                vi.spyOn(terminal, Symbol.asyncDispose)
                    .mockRejectedValueOnce(new Error('late native shutdown unconfirmed'))
                    .mockRejectedValueOnce(new Error('late native shutdown remains unconfirmed'));
                return terminal;
            },
        );
        const started: Promise<void> = expect(
            fixture.host.terminals.start(request('import time;time.sleep(30)')),
        ).rejects.toThrow('owned cleanup are unconfirmed');
        await entered.promise;
        const closing: Promise<void> = expect(fixture.host[Symbol.asyncDispose]()).rejects.toThrow(
            'could not all be released',
        );
        proceed.resolve(undefined);
        await started;
        await closing;
        expect(fixture.host.terminals.size).toBe(1);
        await fixture.host[Symbol.asyncDispose]();
        expect(fixture.host.terminals.size).toBe(0);
    },
);
