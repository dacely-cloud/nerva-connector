// SPDX-FileCopyrightText: 2026 Nerva contributors
// SPDX-License-Identifier: LicenseRef-Proprietary

import { expect, it } from 'vitest';
import { realpath } from 'node:fs/promises';
import {
    HostMcpProtocol,
    type HostJsonObject,
    type HostJsonValue,
} from '../src/host/HostMcpProtocol.js';
import { WindowsHostMcp, WindowsHostMcpMethod } from './support/WindowsHostMcp.js';

it.skipIf(process.platform !== 'win32' || process.env['NERVA_WINDOWS_MCP_SMOKE'] !== '1')(
    'actual Windows cmd.exe standard MCP config preserves environment, persistent stdio and verified Job EOF release',
    async (): Promise<void> => {
        const originalLocal: string | undefined = process.env['LOCALAPPDATA'];
        await using fixture: WindowsHostMcp = await WindowsHostMcp.create();
        const initialized: HostJsonObject = await fixture.request(WindowsHostMcpMethod.Initialize, {
            protocolVersion: HostMcpProtocol.version,
            capabilities: {},
            clientInfo: { name: 'windows-native-proof', version: '1' },
        });
        expect(initialized).toMatchObject({
            protocolVersion: HostMcpProtocol.version,
            serverInfo: { name: 'windows-cmd-stdio-fixture' },
            _meta: { localAppData: fixture.localAppData },
        });
        const metadata: HostJsonObject = HostMcpProtocol.request({
            jsonrpc: '2.0',
            method: 'fixture/meta',
            params: initialized['_meta'],
        }).params;
        const pid: HostJsonValue | undefined = metadata['pid'];
        if (typeof pid !== 'string' || !/^[1-9][0-9]{0,9}$/u.test(pid)) {
            throw new Error('Native MCP process identity is invalid');
        }
        const directory: HostJsonValue | undefined = metadata['directory'];
        if (typeof directory !== 'string') {
            throw new Error('Native MCP working directory is missing');
        }
        expect(await realpath(directory)).toBe(await realpath(fixture.robloxDirectory));
        await fixture.notifyInitialized();
        expect(await fixture.request(WindowsHostMcpMethod.List, {})).toMatchObject({
            tools: [{ name: 'inspect', inputSchema: { type: 'object' } }],
        });
        for (const [index, text] of ['first €', 'second 𝄞'].entries()) {
            const result: HostJsonObject = await fixture.request(WindowsHostMcpMethod.Call, {
                name: 'inspect',
                arguments: { text },
            });
            expect(result).toEqual({
                content: [{ type: 'text', text: JSON.stringify({ pid, call: index + 1, text }) }],
                isError: false,
            });
        }
        expect(await fixture.eof()).toMatchObject({
            running: false,
            treeRunning: false,
            outputComplete: true,
            exitCode: 0,
            signal: null,
            failure: null,
        });
        expect(fixture.starts).toBe(1);
        await fixture.release();
        expect(process.env['LOCALAPPDATA']).toBe(originalLocal);
    },
    60000,
);
