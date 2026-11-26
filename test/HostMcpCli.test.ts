// SPDX-FileCopyrightText: 2026 Dacely <business@dacely.com>
// SPDX-License-Identifier: LicenseRef-Proprietary

import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { expect, it } from 'vitest';

/** Bounded executable observation includes the real protocol stdout and separate diagnostics. */
interface HostCliResult {
    readonly code: number | null;
    readonly stdout: string;
    readonly stderr: string;
}

/** Launch the shipped CLI, close its protocol input and join all owned resources. */
async function run(args: readonly string[], input: string): Promise<HostCliResult> {
    const child: ChildProcessWithoutNullStreams = spawn(
        process.execPath,
        [resolve('build/nerva-connector.mjs'), 'connector', ...args],
        {
            stdio: ['pipe', 'pipe', 'pipe'],
            env: { ...process.env, NODE_OPTIONS: '' },
        },
    );
    const stdout: Buffer[] = [];
    const stderr: Buffer[] = [];
    let bytes: number = 0;
    const timer: NodeJS.Timeout = setTimeout((): void => {
        child.kill('SIGKILL');
    }, 10000);
    try {
        return await new Promise<HostCliResult>(
            (
                resolveResult: (value: HostCliResult) => void,
                reject: (error: Error) => void,
            ): void => {
                child.once('error', reject);
                child.stdout.on('data', (chunk: Buffer): void => {
                    bytes += chunk.byteLength;
                    if (bytes > 2097152) {
                        child.kill('SIGKILL');
                    } else {
                        stdout.push(chunk);
                    }
                });
                child.stderr.on('data', (chunk: Buffer): void => {
                    bytes += chunk.byteLength;
                    if (bytes > 2097152) {
                        child.kill('SIGKILL');
                    } else {
                        stderr.push(chunk);
                    }
                });
                child.once('close', (code: number | null): void =>
                    resolveResult({
                        code,
                        stdout: Buffer.concat(stdout).toString('utf8'),
                        stderr: Buffer.concat(stderr).toString('utf8'),
                    }),
                );
                child.stdin.on('error', (): void => undefined);
                child.stdin.end(input);
            },
        );
    } finally {
        clearTimeout(timer);
    }
}

it('requires explicit full-computer consent before serving MCP or creating files', async (): Promise<void> => {
    const result: HostCliResult = await run(['host-mcp', '--directory', tmpdir()], '');
    expect(result.code).toBe(1);
    expect(result.stdout).toBe('');
    expect(result.stderr).toContain('--full-computer-access');
});

it('the built standalone MCP serves portable file operations with exact bytes and clean stdout', async (): Promise<void> => {
    const directory: string = await mkdtemp(join(tmpdir(), 'nerva-host-mcp-'));
    try {
        const data: string = 'hello\nworld\0';
        const frames: readonly string[] = [
            JSON.stringify({
                jsonrpc: '2.0',
                id: 1,
                method: 'initialize',
                params: {
                    protocolVersion: '2025-11-25',
                    capabilities: {},
                    clientInfo: { name: 'cli-test', version: '1' },
                },
            }),
            JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' }),
            JSON.stringify({
                jsonrpc: '2.0',
                id: 2,
                method: 'tools/call',
                params: {
                    name: 'file_write',
                    arguments: { path: 'hello.txt', data, encoding: 'utf8', mode: 'create' },
                },
            }),
            JSON.stringify({
                jsonrpc: '2.0',
                id: 3,
                method: 'tools/call',
                params: { name: 'file_read', arguments: { path: 'hello.txt' } },
            }),
            JSON.stringify({
                jsonrpc: '2.0',
                id: 4,
                method: 'tools/call',
                params: {
                    name: 'file_write',
                    arguments: {
                        path: 'hello.txt',
                        data: 'replacement',
                        encoding: 'utf8',
                        mode: 'create',
                    },
                },
            }),
        ];
        const result: HostCliResult = await run(
            ['host-mcp', '--full-computer-access', '--directory', directory],
            frames.join('\n') + '\n',
        );
        expect(result.code).toBe(0);
        expect(result.stderr).toContain('Full-computer MCP access is active');
        expect(await readFile(join(directory, 'hello.txt'), 'utf8')).toBe(data);
        const responses: readonly unknown[] = result.stdout
            .trim()
            .split('\n')
            .map((line: string): unknown => JSON.parse(line));
        expect(responses).toHaveLength(4);
        expect(responses[1]).toMatchObject({
            id: 2,
            result: { isError: false, content: [{ text: '{"writtenBytes":"12"}' }] },
        });
        expect(responses[2]).toMatchObject({
            id: 3,
            result: {
                isError: false,
                content: [
                    {
                        text: JSON.stringify({
                            offset: '0',
                            nextOffset: '12',
                            size: '12',
                            eof: true,
                            encoding: 'utf8',
                            data,
                        }),
                    },
                ],
            },
        });
        expect(responses[3]).toMatchObject({ id: 4, result: { isError: true } });
    } finally {
        await rm(directory, { force: true, recursive: true });
    }
});
