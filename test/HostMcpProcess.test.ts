// SPDX-FileCopyrightText: 2026 Nerva contributors
// SPDX-License-Identifier: LicenseRef-Proprietary

import { spawn, type ChildProcess, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { setTimeout as wait } from 'node:timers/promises';
import { expect, it } from 'vitest';
import { Boundary } from 'nerva-connector-protocol/protocol/Boundary.js';
import {
    HostMcpProtocol,
    type HostJsonObject,
    type HostJsonValue,
} from '../src/host/HostMcpProtocol.js';

/** A pending request owns both its exact response identity and its finite observation deadline. */
interface HostMcpPending {
    readonly result: PromiseWithResolvers<HostJsonObject>;
    readonly timer: NodeJS.Timeout;
}

/** Exercise the published CLI and adjacent built worker rather than importing the in-process runtime. */
class HostMcpProcessFixture implements AsyncDisposable {
    readonly #child: ChildProcessWithoutNullStreams;
    readonly #pending: Map<number, HostMcpPending> = new Map();
    readonly #closed: PromiseWithResolvers<number | null> = Promise.withResolvers<number | null>();
    #buffer: string = '';
    #sequence: number = 0;
    #exited: boolean = false;
    #disposal: Promise<void> | null = null;
    public readonly server: string;

    private constructor(public readonly directory: string) {
        this.server = join(directory, 'fixture-mcp.mjs');
        const child: ChildProcess = spawn(
            process.execPath,
            [
                resolve('build/nerva-connector.mjs'),
                'connector',
                'host-mcp',
                '--full-computer-access',
                '--directory',
                directory,
            ],
            {
                cwd: directory,
                env: { ...process.env, NODE_OPTIONS: '' },
                stdio: ['pipe', 'pipe', 'pipe'],
            },
        );
        if (!HostMcpProcessFixture.#piped(child)) {
            child.kill();
            throw new Error('MCP CLI pipes unavailable');
        }
        this.#child = child;
        child.stdout.setEncoding('utf8');
        child.stdout.on('data', (bytes: string): void => this.#receive(bytes));
        child.stderr.resume();
        child.stdin.on('error', (error: Error): void => this.#fail(error));
        child.once('error', (error: Error): void => this.#fail(error));
        child.once('close', (code: number | null): void => {
            this.#exited = true;
            this.#closed.resolve(code);
            this.#fail(new Error('MCP CLI closed before the original response'));
        });
    }

    /** The child fixture implements a normal persistent newline-delimited MCP lifecycle. */
    public static async create(): Promise<HostMcpProcessFixture> {
        const directory: string = await mkdtemp(join(tmpdir(), 'nerva-host-mcp-'));
        const fixture: HostMcpProcessFixture = new HostMcpProcessFixture(directory);
        try {
            await writeFile(
                fixture.server,
                [
                    "import { createInterface } from 'node:readline';",
                    'let count = 0;',
                    'for await (const line of createInterface({ input: process.stdin })) {',
                    '  const request = JSON.parse(line);',
                    '  if (request.id === undefined) continue;',
                    "  const result = request.method === 'initialize'",
                    "    ? { protocolVersion: '2025-11-25', capabilities: { tools: {} }, serverInfo: { name: 'nested-fixture', version: '1' }, _meta: { pid: process.pid, directory: process.cwd() } }",
                    '    : { count: ++count, pid: process.pid };',
                    "  process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id: request.id, result }) + '\\n');",
                    '}',
                ].join('\n'),
            );
            await fixture.request('initialize', {
                protocolVersion: HostMcpProtocol.version,
                capabilities: {},
                clientInfo: { name: 'nested-process-test', version: '1' },
            });
            await fixture.#send({ jsonrpc: '2.0', method: 'notifications/initialized' });
            return fixture;
        } catch (caught: unknown) {
            await fixture[Symbol.asyncDispose]();
            throw caught;
        }
    }

    /** A result is validated JSON and remains bound to its original request ID. */
    public async request(method: string, params: HostJsonObject): Promise<HostJsonObject> {
        const id: number = ++this.#sequence;
        const result: PromiseWithResolvers<HostJsonObject> =
            Promise.withResolvers<HostJsonObject>();
        const timer: NodeJS.Timeout = setTimeout((): void => {
            this.#pending.delete(id);
            result.reject(new Error('Timed out observing the original MCP CLI response'));
        }, 5000);
        this.#pending.set(id, { result, timer });
        try {
            await this.#send({ jsonrpc: '2.0', id, method, params });
            return await result.promise;
        } finally {
            clearTimeout(timer);
            this.#pending.delete(id);
        }
    }

    /** Decode text tool results through the same bounded JSON validator used at runtime. */
    public async call(name: string, args: HostJsonObject): Promise<HostJsonObject> {
        const result: HostJsonObject = await this.request('tools/call', { name, arguments: args });
        expect(result['isError']).toBe(false);
        const content: readonly unknown[] = Boundary.array(result['content'], 1);
        if (!Array.isArray(content) || content.length !== 1) {
            throw new Error('Invalid tool content');
        }
        const first: HostJsonObject = this.#record(content[0]);
        if (first['type'] !== 'text' || typeof first['text'] !== 'string') {
            throw new Error('Invalid tool text');
        }
        const value: unknown = JSON.parse(first['text']);
        return HostMcpProtocol.request({ jsonrpc: '2.0', method: 'fixture/result', params: value })
            .params;
    }

    /** Session EOF must stop running nested servers and release process pipes before the CLI exits. */
    public async [Symbol.asyncDispose](): Promise<void> {
        this.#disposal ??= this.#dispose();
        await this.#disposal;
    }

    async #dispose(): Promise<void> {
        this.#child.stdin.end();
        const timer: NodeJS.Timeout = setTimeout((): void => {
            this.#child.kill();
        }, 2000);
        try {
            const code: number | null = await this.#closed.promise;
            if (!this.#exited || code !== 0) {
                throw new Error('MCP CLI did not finish cleanly');
            }
        } finally {
            clearTimeout(timer);
            this.#child.stdin.destroy();
            this.#child.stdout.destroy();
            this.#child.stderr.destroy();
            await rm(this.directory, { recursive: true, force: true });
        }
    }

    async #send(value: HostJsonObject): Promise<void> {
        await new Promise<void>((resolve_: () => void, reject: (error: Error) => void): void => {
            this.#child.stdin.write(
                JSON.stringify(value) + '\n',
                (error: Error | null | undefined): void => {
                    if (error != null) {
                        reject(error);
                    } else {
                        resolve_();
                    }
                },
            );
        });
    }

    #receive(bytes: string): void {
        this.#buffer += bytes;
        if (this.#buffer.length > 2 * 1024 * 1024) {
            this.#fail(new Error('MCP CLI response exceeded the test bound'));
            this.#child.kill();
            return;
        }
        let newline: number = this.#buffer.indexOf('\n');
        while (newline >= 0) {
            try {
                const raw: unknown = JSON.parse(this.#buffer.slice(0, newline));
                const response: HostJsonObject = HostMcpProtocol.request({
                    jsonrpc: '2.0',
                    method: 'fixture/reply',
                    params: raw,
                }).params;
                const id: HostJsonValue | undefined = response['id'];
                if (typeof id !== 'number') {
                    throw new Error('Invalid MCP CLI response identity');
                }
                const pending: HostMcpPending | undefined = this.#pending.get(id);
                if (pending === undefined) {
                    throw new Error('MCP CLI response has no original owner');
                }
                pending.result.resolve(this.#record(response['result']));
            } catch (caught: unknown) {
                this.#fail(
                    caught instanceof Error ? caught : new Error('Invalid MCP CLI response'),
                );
            }
            this.#buffer = this.#buffer.slice(newline + 1);
            newline = this.#buffer.indexOf('\n');
        }
    }

    #record(value: unknown): HostJsonObject {
        if (value === null || typeof value !== 'object' || Array.isArray(value)) {
            throw new Error('Invalid MCP JSON object');
        }
        return HostMcpProtocol.request({ jsonrpc: '2.0', method: 'fixture/object', params: value })
            .params;
    }

    #fail(error: Error): void {
        for (const pending of this.#pending.values()) {
            pending.result.reject(error);
        }
    }

    static #piped(child: ChildProcess): child is ChildProcessWithoutNullStreams {
        return child.stdin !== null && child.stdout !== null && child.stderr !== null;
    }
}

/** Poll retained output of one exact host process without launching replacement commands. */
async function childResponse(
    fixture: HostMcpProcessFixture,
    processId: string,
    offset: string,
): Promise<HostJsonObject> {
    let output: string = '';
    let cursor: string = offset;
    for (let attempt: number = 0; attempt < 100; attempt += 1) {
        const snapshot: HostJsonObject = await fixture.call('process_read', {
            processId,
            stdoutOffset: cursor,
        });
        const stdout: HostJsonObject = HostMcpProtocol.request({
            jsonrpc: '2.0',
            method: 'fixture/stdout',
            params: snapshot['stdout'],
        }).params;
        if (typeof stdout['data'] !== 'string' || typeof stdout['nextOffset'] !== 'string') {
            throw new Error('Invalid retained process output');
        }
        expect(snapshot['processId']).toBe(processId);
        expect(stdout['encoding']).toBe('utf8');
        expect(stdout['truncated']).toBe(false);
        output += stdout['data'];
        cursor = stdout['nextOffset'];
        if (output.endsWith('\n')) {
            const value: unknown = JSON.parse(output.trim());
            return {
                response: HostMcpProtocol.request({
                    jsonrpc: '2.0',
                    method: 'fixture/child',
                    params: value,
                }).params,
                cursor,
            };
        }
        await wait(20);
    }
    throw new Error('Original MCP child did not respond');
}

it('built CLI launches and uses one retained stdio MCP child, then stops and releases its ownership', async (): Promise<void> => {
    await using fixture: HostMcpProcessFixture = await HostMcpProcessFixture.create();
    const started: HostJsonObject = await fixture.call('process_start', {
        executable: process.execPath,
        arguments: [fixture.server],
        timeoutMs: 30000,
    });
    const processId: HostJsonValue | undefined = started['processId'];
    if (typeof processId !== 'string') {
        throw new Error('Missing original host process');
    }
    await fixture.call('process_write', {
        processId,
        data:
            JSON.stringify({
                jsonrpc: '2.0',
                id: 10,
                method: 'initialize',
                params: {
                    protocolVersion: HostMcpProtocol.version,
                    capabilities: {},
                    clientInfo: { name: 'host', version: '1' },
                },
            }) + '\n',
        encoding: 'utf8',
        end: false,
    });
    const initialization: HostJsonObject = await childResponse(fixture, processId, '0');
    expect(initialization['response']).toMatchObject({
        id: 10,
        result: {
            protocolVersion: HostMcpProtocol.version,
            serverInfo: { name: 'nested-fixture' },
            _meta: { directory: fixture.directory },
        },
    });
    const cursor: HostJsonValue | undefined = initialization['cursor'];
    if (typeof cursor !== 'string') {
        throw new Error('Missing output continuation');
    }
    await fixture.call('process_write', {
        processId,
        data:
            JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' }) +
            '\n' +
            JSON.stringify({ jsonrpc: '2.0', id: 11, method: 'ping' }) +
            '\n',
        encoding: 'utf8',
        end: false,
    });
    expect((await childResponse(fixture, processId, cursor))['response']).toMatchObject({
        id: 11,
        result: { count: 1 },
    });
    expect(await fixture.call('process_stop', { processId })).toEqual({ stopped: true });
    expect(await fixture.call('process_release', { processId })).toEqual({ released: true });
});

/** Runtime JSON narrowing preserves the named object type for nested child responses. */
function isJsonObject(value: HostJsonValue | undefined): value is HostJsonObject {
    return value !== null && typeof value === 'object' && !Array.isArray(value);
}

it('built CLI session EOF releases a still-running nested MCP child', async (): Promise<void> => {
    await using fixture: HostMcpProcessFixture = await HostMcpProcessFixture.create();
    const started: HostJsonObject = await fixture.call('process_start', {
        executable: process.execPath,
        arguments: [fixture.server],
        timeoutMs: 30000,
    });
    const processId: HostJsonValue | undefined = started['processId'];
    if (typeof processId !== 'string') {
        throw new Error('Missing original host process');
    }
    await fixture.call('process_write', {
        processId,
        data: JSON.stringify({ jsonrpc: '2.0', id: 20, method: 'initialize' }) + '\n',
        encoding: 'utf8',
        end: false,
    });
    const response: HostJsonValue | undefined = (await childResponse(fixture, processId, '0'))[
        'response'
    ];
    if (!isJsonObject(response) || !isJsonObject(response['result'])) {
        throw new Error('Invalid original child response');
    }
    const metadata: HostJsonValue | undefined = response['result']['_meta'];
    if (
        !isJsonObject(metadata) ||
        typeof metadata['pid'] !== 'number' ||
        !Number.isSafeInteger(metadata['pid'])
    ) {
        throw new Error('Invalid original child identity');
    }
    const pid: number = metadata['pid'];
    expect((): void => {
        process.kill(pid, 0);
    }).not.toThrow();
    await fixture[Symbol.asyncDispose]();
    let live: boolean = true;
    for (let attempt: number = 0; live && attempt < 100; attempt += 1) {
        try {
            process.kill(pid, 0);
        } catch {
            live = false;
        }
        if (live) {
            await wait(20);
        }
    }
    expect(live).toBe(false);
});
