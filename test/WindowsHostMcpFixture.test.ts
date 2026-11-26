// SPDX-FileCopyrightText: 2026 Dacely <business@dacely.com>
// SPDX-License-Identifier: LicenseRef-Proprietary

import { execFile, type ChildProcess } from 'node:child_process';
import { expect, it } from 'vitest';
import {
    HostMcpProtocol,
    type HostJsonObject,
    type HostJsonValue,
} from '../src/host/HostMcpProtocol.js';
import { WindowsHostMcpPeer } from './support/WindowsHostMcpPeer.js';

/** The fixture source has an actual portable Node lifecycle; this test makes no Windows or batch-execution claim. */
it('the isolated MCP peer completes initialize, list, two calls and EOF without a desktop or Windows simulation', async (): Promise<void> => {
    const input: string = [
        { jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-11-25' } },
        { jsonrpc: '2.0', method: 'notifications/initialized' },
        { jsonrpc: '2.0', id: 2, method: 'tools/list' },
        {
            jsonrpc: '2.0',
            id: 3,
            method: 'tools/call',
            params: { name: 'inspect', arguments: { text: 'first €' } },
        },
        {
            jsonrpc: '2.0',
            id: 4,
            method: 'tools/call',
            params: { name: 'inspect', arguments: { text: 'second 𝄞' } },
        },
    ]
        .map((frame): string => JSON.stringify(frame) + '\n')
        .join('');
    const output: string = await new Promise<string>(
        (resolve: (value: string) => void, reject: (error: Error) => void): void => {
            const child: ChildProcess = execFile(
                process.execPath,
                ['--input-type=module', '-e', WindowsHostMcpPeer.source],
                { timeout: 5000, maxBuffer: 65536 },
                (error: Error | null, stdout: string, stderr: string): void => {
                    if (error !== null) {
                        reject(error);
                    } else if (stderr !== WindowsHostMcpPeer.completed) {
                        reject(new Error('Fixture EOF marker missing'));
                    } else {
                        resolve(stdout);
                    }
                },
            );
            child.stdin?.on('error', reject);
            child.stdin?.end(input);
        },
    );
    expect(output.endsWith('\n')).toBe(true);
    const lines: readonly string[] = output.trimEnd().split('\n');
    expect(lines).toHaveLength(4);
    const frames: HostJsonObject[] = [];
    for (let index: number = 0; index < lines.length; index++) {
        const line: string | undefined = lines[index];
        if (line === undefined) {
            throw new Error('Missing fixture frame');
        }
        const raw: unknown = JSON.parse(line);
        expect(raw).toMatchObject({ jsonrpc: '2.0', id: index + 1 });
        frames.push(
            HostMcpProtocol.request({ jsonrpc: '2.0', method: 'fixture/response', params: raw })
                .params,
        );
    }
    const initialize: HostJsonObject | undefined = frames[0];
    if (initialize === undefined) {
        throw new Error('Fixture initialization response missing');
    }
    const result: HostJsonObject = HostMcpProtocol.request({
        jsonrpc: '2.0',
        method: 'fixture/result',
        params: initialize['result'],
    }).params;
    expect(result).toMatchObject({
        protocolVersion: HostMcpProtocol.version,
        capabilities: { tools: {} },
        serverInfo: { name: 'windows-cmd-stdio-fixture', version: '1' },
        _meta: { directory: process.cwd() },
    });
    const metadata: HostJsonObject = HostMcpProtocol.request({
        jsonrpc: '2.0',
        method: 'fixture/metadata',
        params: result['_meta'],
    }).params;
    const pid: HostJsonValue | undefined = metadata['pid'];
    if (typeof pid !== 'string' || !/^[1-9][0-9]{0,9}$/u.test(pid)) {
        throw new Error('Fixture process identity missing');
    }
    expect(frames[1]).toMatchObject({
        result: { tools: [{ name: 'inspect', inputSchema: { type: 'object' } }] },
    });
    for (const [index, text] of ['first €', 'second 𝄞'].entries()) {
        expect(frames[index + 2]).toEqual({
            jsonrpc: '2.0',
            id: index + 3,
            result: {
                content: [{ type: 'text', text: JSON.stringify({ pid, call: index + 1, text }) }],
                isError: false,
            },
        });
    }
    expect(WindowsHostMcpPeer.batch).toBe(
        '@echo off\r\n"%NERVA_WINDOWS_MCP_NODE%" "%~dp0peer.mjs"\r\n',
    );
});
