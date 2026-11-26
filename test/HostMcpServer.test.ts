// SPDX-FileCopyrightText: 2026 Dacely <business@dacely.com>
// SPDX-License-Identifier: LicenseRef-Proprietary

import { PassThrough, Writable } from 'node:stream';
import { expect, it } from 'vitest';
import { HostMcpServer } from '../src/host/HostMcpServer.js';
import {
    HostMcpProtocol,
    type HostJsonObject,
    type HostMcpTools,
    type HostMcpTool,
} from '../src/host/HostMcpProtocol.js';

/** Test owner records actual transport dispatch without bypassing protocol validation. */
class McpToolsFixture implements HostMcpTools {
    public readonly tools: readonly HostMcpTool[] = [
        { name: 'probe', description: 'Probe', inputSchema: { type: 'object' } },
    ];
    public readonly calls: string[] = [];
    public call(name: string, args: HostJsonObject): Promise<string> {
        this.calls.push(name);
        if (args['fail'] === true) {
            return Promise.reject(new Error('Private host diagnostics'));
        }
        return Promise.resolve(JSON.stringify(args));
    }
}

/** Simulates a connected client that stops draining protocol output. */
class BlockedMcpOutput extends Writable {
    public override _write(
        _chunk: Buffer,
        _encoding: BufferEncoding,
        _callback: (error?: Error | null) => void,
    ): void {}
}

/** Send real newline-delimited byte frames through the stdio server. */
async function run(lines: readonly string[], tools: McpToolsFixture): Promise<string> {
    const input: PassThrough = new PassThrough();
    const output: PassThrough = new PassThrough();
    const chunks: Buffer[] = [];
    output.on('data', (chunk: Buffer): void => {
        chunks.push(chunk);
    });
    const running: Promise<void> = new HostMcpServer(tools, input, output).run(
        new AbortController().signal,
    );
    input.end(lines.join('\n') + '\n');
    await running;
    return Buffer.concat(chunks).toString('utf8');
}

const initialization: string = JSON.stringify({
    jsonrpc: '2.0',
    id: 1,
    method: 'initialize',
    params: {
        protocolVersion: HostMcpProtocol.version,
        capabilities: {},
        clientInfo: { name: 'test', version: '1' },
    },
});
const initialized: string = JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' });

it('negotiates MCP once and dispatches tools only after initialized notification', async (): Promise<void> => {
    const tools: McpToolsFixture = new McpToolsFixture();
    const result: string = await run(
        [
            '{"jsonrpc":"2.0","id":0,"method":"tools/call","params":{"name":"probe"}}',
            initialization,
            initialized,
            '{"jsonrpc":"2.0","id":2,"method":"tools/list"}',
            '{"jsonrpc":"2.0","id":3,"method":"tools/call","params":{"name":"probe","arguments":{"value":"ok"}}}',
            '{"jsonrpc":"2.0","method":"unknown/notification"}',
        ],
        tools,
    );
    const replies: readonly unknown[] = result
        .trim()
        .split('\n')
        .map((line: string): unknown => JSON.parse(line));
    expect(replies).toHaveLength(4);
    expect(replies[0]).toMatchObject({ id: 0, error: { code: -32002 } });
    expect(replies[1]).toMatchObject({
        id: 1,
        result: { protocolVersion: HostMcpProtocol.version },
    });
    expect(replies[2]).toMatchObject({ id: 2, result: { tools: [{ name: 'probe' }] } });
    expect(replies[3]).toMatchObject({
        id: 3,
        result: { content: [{ type: 'text', text: '{"value":"ok"}' }], isError: false },
    });
    expect(tools.calls).toEqual(['probe']);
});

it('keeps malformed requests, unknown tools and tool failures distinct without leaking diagnostics', async (): Promise<void> => {
    const tools: McpToolsFixture = new McpToolsFixture();
    const result: string = await run(
        [
            initialization,
            initialized,
            'broken',
            '{"jsonrpc":"2.0","id":9007199254740993,"method":"ping"}',
            '{"jsonrpc":"2.0","id":2,"method":"tools/call","params":{"name":"foreign"}}',
            '{"jsonrpc":"2.0","id":3,"method":"tools/call","params":{"name":"probe","arguments":{"fail":true}}}',
        ],
        tools,
    );
    const replies: readonly unknown[] = result
        .trim()
        .split('\n')
        .map((line: string): unknown => JSON.parse(line));
    expect(replies[1]).toMatchObject({ error: { code: -32700 } });
    expect(replies[2]).toMatchObject({ error: { code: -32600 } });
    expect(replies[3]).toMatchObject({ id: 2, error: { code: -32602 } });
    expect(replies[4]).toMatchObject({ id: 3, result: { isError: true } });
    expect(result).not.toContain('Private host diagnostics');
    expect(tools.calls).toEqual(['probe']);
});

it('rejects oversized frames before JSON dispatch and deeply nested parameters before operations', async (): Promise<void> => {
    const tools: McpToolsFixture = new McpToolsFixture();
    await expect(run(['x'.repeat(HostMcpProtocol.maximumBytes + 1)], tools)).rejects.toThrow(
        'frame limit',
    );
    const nested: unknown = JSON.parse('['.repeat(40) + '0' + ']'.repeat(40));
    expect((): void => {
        HostMcpProtocol.request({
            jsonrpc: '2.0',
            id: 1,
            method: 'tools/call',
            params: {
                nested,
            },
        });
    }).toThrow('resource limit');
    expect(tools.calls).toEqual([]);
});

it('revoking the session aborts a waiting reader without another host operation', async (): Promise<void> => {
    const input: PassThrough = new PassThrough();
    const tools: McpToolsFixture = new McpToolsFixture();
    const stop: AbortController = new AbortController();
    const running: Promise<void> = new HostMcpServer(tools, input, new PassThrough()).run(
        stop.signal,
    );
    stop.abort();
    await running;
    expect(tools.calls).toEqual([]);
    expect(input.destroyed).toBe(true);
});

it('bounds a client that stops reading stdout and releases the input session', async (): Promise<void> => {
    const input: PassThrough = new PassThrough();
    const output: BlockedMcpOutput = new BlockedMcpOutput();
    const running: Promise<void> = new HostMcpServer(new McpToolsFixture(), input, output, 10).run(
        new AbortController().signal,
    );
    input.end(initialization + '\n');
    await expect(running).rejects.toThrow('output deadline');
    expect(output.destroyed).toBe(true);
    expect(input.destroyed).toBe(true);
});
