// SPDX-FileCopyrightText: 2026 Nerva contributors
// SPDX-License-Identifier: LicenseRef-Proprietary

import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { expect, it } from 'vitest';
import { Boundary } from 'nerva-connector-protocol/protocol/Boundary.js';
import { HostMcpProtocol, type HostJsonObject } from '../src/host/HostMcpProtocol.js';

/** Exactly one bounded MCP request belongs to this smoke fixture at a time. */
interface BuiltTerminalPending {
    readonly id: number;
    readonly result: PromiseWithResolvers<HostJsonObject>;
    readonly timer: NodeJS.Timeout;
}

/** The current bundle and adjacent native ELF run in place; only the task directory is temporary. */
class BuiltTerminalMcp implements AsyncDisposable {
    readonly #child: ChildProcessWithoutNullStreams;
    readonly #closed: PromiseWithResolvers<number | null> = Promise.withResolvers<number | null>();
    #pending: BuiltTerminalPending | null = null;
    #buffer: Buffer = Buffer.alloc(0);
    #sequence: number = 0;
    #failure: Error | null = null;

    private constructor(public readonly directory: string) {
        this.#child = spawn(
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
        this.#child.stdout.on('data', (bytes: Buffer): void => this.#receive(bytes));
        this.#child.stderr.resume();
        this.#child.stdin.on('error', (error: Error): void => this.#failed(error));
        this.#child.once('error', (error: Error): void => this.#failed(error));
        this.#child.once('close', (code: number | null): void => {
            this.#closed.resolve(code);
            if (this.#pending !== null) {
                this.#failed(new Error('Built MCP CLI exited before its original response'));
            }
        });
    }

    public static async create(): Promise<BuiltTerminalMcp> {
        const directory: string = await mkdtemp(join(tmpdir(), 'nerva-built-pty-'));
        let fixture: BuiltTerminalMcp | null = null;
        try {
            fixture = new BuiltTerminalMcp(directory);
            const initialized: HostJsonObject = await fixture.request('initialize', {
                protocolVersion: HostMcpProtocol.version,
                capabilities: {},
                clientInfo: { name: 'built-terminal-smoke', version: '1' },
            });
            expect(initialized['protocolVersion']).toBe(HostMcpProtocol.version);
            await fixture.#send({ jsonrpc: '2.0', method: 'notifications/initialized' });
            return fixture;
        } catch (error: unknown) {
            if (fixture !== null) {
                await fixture[Symbol.asyncDispose]();
            } else {
                await rm(directory, { recursive: true, force: true });
            }
            throw error;
        }
    }

    public async request(method: string, params: HostJsonObject): Promise<HostJsonObject> {
        if (this.#failure !== null) {
            throw this.#failure;
        }
        if (this.#pending !== null || this.#sequence >= 1000) {
            throw new Error('Built MCP request admission exceeded its bound');
        }
        const id: number = ++this.#sequence;
        const result: PromiseWithResolvers<HostJsonObject> =
            Promise.withResolvers<HostJsonObject>();
        const timer: NodeJS.Timeout = setTimeout(
            (): void => result.reject(new Error('Built MCP original response timed out')),
            10000,
        );
        this.#pending = { id, result, timer };
        try {
            await Promise.all([this.#send({ jsonrpc: '2.0', id, method, params }), result.promise]);
            return await result.promise;
        } finally {
            clearTimeout(timer);
            this.#pending = null;
        }
    }

    public async call(name: string, args: HostJsonObject): Promise<HostJsonObject> {
        const result: HostJsonObject = await this.request('tools/call', { name, arguments: args });
        expect(result['isError']).toBe(false);
        const content: readonly unknown[] = Boundary.array(result['content'], 1);
        if (content.length !== 1) {
            throw new Error('One bounded MCP text result required');
        }
        const item: Readonly<Record<string, unknown>> = Boundary.record(content[0], [
            'type',
            'text',
        ]);
        if (
            item['type'] !== 'text' ||
            typeof item['text'] !== 'string' ||
            Buffer.byteLength(item['text']) > HostMcpProtocol.maximumBytes
        ) {
            throw new Error('Invalid bounded MCP tool result');
        }
        const raw: unknown = JSON.parse(item['text']);
        return HostMcpProtocol.request({ jsonrpc: '2.0', method: 'smoke/result', params: raw })
            .params;
    }

    public async [Symbol.asyncDispose](): Promise<void> {
        this.#child.stdin.end();
        let forced: boolean = false;
        const timer: NodeJS.Timeout = setTimeout((): void => {
            forced = true;
            this.#child.kill();
        }, 5000);
        try {
            const code: number | null = await this.#closed.promise;
            if (forced || code !== 0) {
                throw new Error('Built MCP CLI did not join graceful shutdown');
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
        const bytes: Buffer = Buffer.from(JSON.stringify(value) + '\n');
        if (bytes.length > HostMcpProtocol.maximumBytes) {
            throw new Error('Built MCP request exceeds its bound');
        }
        await new Promise<void>((resolve_: () => void, reject: (error: Error) => void): void => {
            this.#child.stdin.write(bytes, (error: Error | null | undefined): void => {
                if (error === null || error === undefined) {
                    resolve_();
                } else {
                    reject(error);
                }
            });
        });
    }

    #receive(bytes: Buffer): void {
        try {
            if (
                !Buffer.isBuffer(bytes) ||
                this.#buffer.length + bytes.length > 2 * HostMcpProtocol.maximumBytes
            ) {
                throw new Error('Built MCP stdout exceeded its frame bound');
            }
            this.#buffer = Buffer.concat([this.#buffer, bytes]);
            for (
                let end: number = this.#buffer.indexOf(10);
                end >= 0;
                end = this.#buffer.indexOf(10)
            ) {
                if (end > HostMcpProtocol.maximumBytes) {
                    throw new Error('Built MCP frame exceeded its bound');
                }
                const raw: unknown = JSON.parse(
                    new TextDecoder('utf-8', { fatal: true }).decode(this.#buffer.subarray(0, end)),
                );
                this.#buffer = this.#buffer.subarray(end + 1);
                const value: Readonly<Record<string, unknown>> = Boundary.record(raw, [
                    'jsonrpc',
                    'id',
                    'result',
                    'error',
                ]);
                if (
                    value['jsonrpc'] !== '2.0' ||
                    typeof value['id'] !== 'number' ||
                    value['id'] !== this.#pending?.id ||
                    Object.hasOwn(value, 'error') ||
                    !Object.hasOwn(value, 'result')
                ) {
                    throw new Error('Built MCP response changed its original identity or failed');
                }
                const result: HostJsonObject = HostMcpProtocol.request({
                    jsonrpc: '2.0',
                    method: 'smoke/reply',
                    params: value['result'],
                }).params;
                this.#pending.result.resolve(result);
            }
            if (this.#buffer.length > HostMcpProtocol.maximumBytes) {
                throw new Error('Built MCP incomplete frame exceeded its bound');
            }
        } catch (error: unknown) {
            this.#failed(error instanceof Error ? error : new Error('Invalid built MCP response'));
        }
    }

    #failed(error: Error): void {
        this.#failure ??= error;
        this.#pending?.result.reject(error);
    }
}

/** Decode one exact window without interpreting terminal bytes as a text-only stream. */
function output(snapshot: HostJsonObject): Buffer {
    const value: Readonly<Record<string, unknown>> = Boundary.record(snapshot['output'], [
        'offset',
        'nextOffset',
        'endOffset',
        'truncated',
        'encoding',
        'data',
    ]);
    if (
        typeof value['data'] !== 'string' ||
        (value['encoding'] !== 'utf8' && value['encoding'] !== 'base64') ||
        value['truncated'] !== false
    ) {
        throw new Error('Exact untruncated terminal output required');
    }
    const bytes: Buffer = Buffer.from(value['data'], value['encoding']);
    if (value['encoding'] === 'base64' && bytes.toString('base64') !== value['data']) {
        throw new Error('Canonical terminal bytes required');
    }
    expect(Boundary.integer(value['nextOffset'])).toBe(
        Boundary.integer(value['offset']) + BigInt(bytes.length),
    );
    expect(Boundary.integer(value['nextOffset'])).toBeLessThanOrEqual(
        Boundary.integer(value['endOffset']),
    );
    return bytes;
}

it.skipIf(process.platform !== 'linux')(
    'the built host-mcp CLI exposes all six terminal tools through its embedded Linux pin and executes a real PTY with exact EOF',
    async (): Promise<void> => {
        await using fixture: BuiltTerminalMcp = await BuiltTerminalMcp.create();
        const listing: HostJsonObject = await fixture.request('tools/list', {});
        const tools: readonly unknown[] = Boundary.array(listing['tools'], 64);
        const names: readonly string[] = tools.map((raw: unknown): string =>
            Boundary.text(Boundary.record(raw, ['name', 'description', 'inputSchema'])['name']),
        );
        expect(
            names.filter((name: string): boolean => name.startsWith('terminal_')).sort(),
        ).toEqual([
            'terminal_read',
            'terminal_release',
            'terminal_resize',
            'terminal_start',
            'terminal_stop',
            'terminal_write',
        ]);
        let snapshot: HostJsonObject = await fixture.call('terminal_start', {
            executable: process.execPath,
            arguments: [
                '-e',
                "if(!process.stdin.isTTY||!process.stdout.isTTY||!process.stderr.isTTY)process.exit(99);process.stdout.write('BUILT-PTY:111');process.exit(7)",
            ],
            cols: 80,
            rows: 24,
            timeoutMs: 10000,
        });
        const id: string = Boundary.id(snapshot['processId']);
        for (
            let attempt: number = 0;
            snapshot['outputComplete'] !== true && attempt < 100;
            attempt += 1
        ) {
            await delay(10);
            snapshot = await fixture.call('terminal_read', {
                processId: id,
                offset: '0',
                maximumBytes: 32768,
            });
        }
        expect(snapshot['running']).toBe(false);
        expect(snapshot['treeRunning']).toBeNull();
        expect(snapshot['exitCode']).toBe(7);
        expect(snapshot['outputComplete']).toBe(true);
        expect(output(snapshot)).toEqual(Buffer.from('BUILT-PTY:111'));
        expect(Boundary.integer(snapshot['finalOutputBytes'])).toBe(13n);
        expect((await fixture.call('terminal_release', { processId: id }))['released']).toBe(true);
    },
);
