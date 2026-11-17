// SPDX-FileCopyrightText: 2026 Nerva contributors
// SPDX-License-Identifier: LicenseRef-Proprietary

import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { HostWorkspace } from '../../src/host/HostWorkspace.js';
import { HostWindowsBuild } from '../../src/host/HostWindowsBuild.js';
import { HostMcpProtocol, type HostJsonObject } from '../../src/host/HostMcpProtocol.js';
import { Boundary } from 'nerva-connector-protocol/protocol/Boundary.js';
import {
    HostOperation,
    type HostWorkspaceAccess,
    type HostWorkspaceAuthorization,
    type HostProcessSnapshot,
    type HostProcessOutput,
} from '../../src/host/HostWorkspaceTypes.js';
import { WindowsHostMcpPeer } from './WindowsHostMcpPeer.js';

/** The caller uses real MCP request names while notifications stay distinct from request identities. */
export const WindowsHostMcpMethod = {
    Initialize: 'initialize',
    List: 'tools/list',
    Call: 'tools/call',
} as const;
/** Request method values remain closed independently from the notification lifecycle. */
export type WindowsHostMcpMethod = (typeof WindowsHostMcpMethod)[keyof typeof WindowsHostMcpMethod];

/** Actual native pipes, one verified Windows Job owner and a single bounded protocol reply belong to this fixture. */
export class WindowsHostMcp implements AsyncDisposable, HostWorkspaceAuthorization {
    #workspace: HostWorkspace | null = null;
    #processId: string | null = null;
    #stdout: bigint = 0n;
    #stderr: bigint = 0n;
    #pending: Buffer = Buffer.alloc(0);
    #errors: Buffer = Buffer.alloc(0);
    #sequence: number = 0;
    #cleanup: Promise<void> | null = null;
    /** Authorization observes one actual process admission for the persistent peer. */
    public starts: number = 0;
    /** All material belongs to one existing temp root; no build or dependency directory is created. */
    private constructor(public readonly directory: string) {}
    /** Native environment expansion and cd run only inside the fixture's spaces/Unicode LOCALAPPDATA. */
    public get localAppData(): string {
        return join(this.directory, 'Local AppData Å 日本', 'Local');
    }
    /** The persistent batch peer must run from the directory selected by the exact requested cmd text. */
    public get robloxDirectory(): string {
        return join(this.localAppData, 'Roblox');
    }
    /** Only the current built broker verified against its source/executable commitment can launch the test. */
    public static async create(): Promise<WindowsHostMcp> {
        const fixture: WindowsHostMcp = new WindowsHostMcp(
            await mkdtemp(join(tmpdir(), 'nerva-win-mcp-')),
        );
        try {
            fixture.#workspace = await HostWorkspace.create({
                directory: fixture.directory,
                authorization: fixture,
                windowsLauncher: await HostWindowsBuild.verifiedExecutable(),
            });
            await mkdir(fixture.robloxDirectory, { recursive: true });
            await writeFile(join(fixture.robloxDirectory, 'peer.mjs'), WindowsHostMcpPeer.source, {
                flag: 'wx',
            });
            await writeFile(join(fixture.robloxDirectory, 'mcp.bat'), WindowsHostMcpPeer.batch, {
                flag: 'wx',
            });
            const localKey: string =
                Object.keys(process.env).find(
                    (key: string): boolean => key.toLowerCase() === 'localappdata',
                ) ?? 'LOCALAPPDATA';
            const started: HostProcessSnapshot = await fixture.#workspace.start({
                executable: 'cmd.exe',
                arguments: ['/c', 'cd /d %LOCALAPPDATA%\\Roblox && .\\mcp.bat'],
                shell: null,
                command: null,
                directory: fixture.directory,
                environment: {
                    [localKey]: fixture.localAppData,
                    NERVA_WINDOWS_MCP_NODE: process.execPath,
                },
                timeoutMs: 45000,
            });
            fixture.#processId = started.processId;
            return fixture;
        } catch (error: unknown) {
            await fixture[Symbol.asyncDispose]();
            throw error;
        }
    }
    /** Explicit local fixture authority is checked by every actual process read, write, stop and release. */
    public authorize(access: HostWorkspaceAccess): Promise<void> {
        if (access.operation === HostOperation.Start) {
            this.starts++;
        }
        return Promise.resolve();
    }
    #owner(): HostWorkspace {
        if (this.#workspace === null) {
            throw new Error('Windows MCP fixture has no native owner');
        }
        return this.#workspace;
    }
    #id(): string {
        if (this.#processId === null) {
            throw new Error('Windows MCP fixture did not create its process');
        }
        return this.#processId;
    }
    /** Request bytes go through the ordinary native process writer and responses retain the exact original ID. */
    public async request(
        method: WindowsHostMcpMethod,
        params: HostJsonObject,
    ): Promise<HostJsonObject> {
        const id: number = ++this.#sequence;
        await this.#send({ jsonrpc: '2.0', id, method, params });
        for (let attempt: number = 0; attempt < 400; attempt++) {
            const snapshot: HostProcessSnapshot = await this.#read();
            const newline: number = this.#pending.indexOf(10);
            if (newline >= 0) {
                if (newline !== this.#pending.length - 1) {
                    throw new Error('Unexpected extra MCP response');
                }
                const raw: unknown = JSON.parse(
                    new TextDecoder('utf-8', { fatal: true }).decode(
                        this.#pending.subarray(0, newline),
                    ),
                );
                this.#pending = Buffer.alloc(0);
                const response: Readonly<Record<string, unknown>> = Boundary.record(raw, [
                    'jsonrpc',
                    'id',
                    'result',
                ]);
                if (response['jsonrpc'] !== '2.0' || response['id'] !== id) {
                    throw new Error('MCP response identity changed');
                }
                return HostMcpProtocol.request({
                    jsonrpc: '2.0',
                    method: 'fixture/result',
                    params: response['result'],
                }).params;
            }
            if (snapshot.outputComplete) {
                throw new Error('Native MCP peer closed before response');
            }
            await delay(20);
        }
        throw new Error('Original native MCP response deadline exceeded');
    }
    /** Notifications have no response ID and use the same retained pipe. */
    public notifyInitialized(): Promise<void> {
        return this.#send({ jsonrpc: '2.0', method: 'notifications/initialized' });
    }
    async #send(frame: HostJsonObject): Promise<void> {
        const bytes: Buffer = Buffer.from(JSON.stringify(frame) + '\n');
        if (bytes.length > 4096) {
            throw new Error('Native MCP input exceeds its fixture bound');
        }
        await this.#owner().input(this.#id(), bytes, false);
    }
    async #read(): Promise<HostProcessSnapshot> {
        const snapshot: HostProcessSnapshot = await this.#owner().output(
            this.#id(),
            this.#stdout,
            this.#stderr,
            32768,
        );
        this.#stdout = this.#append(snapshot.stdout, this.#stdout, true);
        this.#stderr = this.#append(snapshot.stderr, this.#stderr, false);
        return snapshot;
    }
    #append(output: HostProcessOutput, cursor: bigint, stdout: boolean): bigint {
        if (
            output.truncated ||
            output.offset !== cursor ||
            output.nextOffset !== cursor + BigInt(output.bytes.length) ||
            output.nextOffset > output.endOffset
        ) {
            throw new Error('Native MCP output lost its exact byte range');
        }
        if (stdout) {
            if (this.#pending.length + output.bytes.length > 65536) {
                throw new Error('MCP frame exceeded fixture bound');
            }
            this.#pending = Buffer.concat([this.#pending, output.bytes]);
        } else {
            if (this.#errors.length + output.bytes.length > 4096) {
                throw new Error('MCP stderr exceeded fixture bound');
            }
            this.#errors = Buffer.concat([this.#errors, output.bytes]);
        }
        return output.nextOffset;
    }
    /** EOF is real stdin closure; root exit, actual Job emptiness and both byte totals must independently agree. */
    public async eof(): Promise<HostProcessSnapshot> {
        await this.#owner().input(this.#id(), Buffer.alloc(0), true);
        for (let attempt: number = 0; attempt < 500; attempt++) {
            const snapshot: HostProcessSnapshot = await this.#read();
            if (!snapshot.running && snapshot.treeRunning === false && snapshot.outputComplete) {
                if (
                    snapshot.stdoutFinalBytes !== this.#stdout ||
                    snapshot.stderrFinalBytes !== this.#stderr ||
                    this.#pending.length !== 0 ||
                    this.#errors.toString('utf8') !== WindowsHostMcpPeer.completed
                ) {
                    throw new Error('Native MCP final output totals changed');
                }
                return snapshot;
            }
            await delay(20);
        }
        throw new Error('Windows MCP EOF/Job join deadline exceeded');
    }
    /** Successful release drops only this exact already-joined native cell. */
    public async release(): Promise<void> {
        const id: string = this.#id();
        await this.#owner().release(id);
        this.#processId = null;
    }
    /** A joined workspace precedes directory deletion; a failed native join preserves ownership for retry. */
    public async [Symbol.asyncDispose](): Promise<void> {
        this.#cleanup ??= this.#dispose();
        try {
            await this.#cleanup;
        } catch (error: unknown) {
            this.#cleanup = null;
            throw error;
        }
    }
    async #dispose(): Promise<void> {
        await this.#workspace?.[Symbol.asyncDispose]();
        this.#workspace = null;
        await rm(this.directory, { recursive: true, force: true });
    }
}
