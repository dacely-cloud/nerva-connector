// SPDX-FileCopyrightText: 2026 Nerva contributors
// SPDX-License-Identifier: LicenseRef-Proprietary

import type { HostMcpWorkspaceBounds } from './HostMcpWorkspaceBounds.js';

import { Boundary } from 'nerva-connector-protocol/protocol/Boundary.js';
import { SystemInfo } from '../system/SystemInfo.js';
import { HostFileSnapshotCodec } from './HostFileSnapshotCodec.js';
import { HostWorkspace } from './HostWorkspace.js';
import { HostWorkspaceValidation } from './HostWorkspaceValidation.js';
import { HostMcpWorkspaceCatalog } from './HostMcpWorkspaceCatalog.js';
import { HostHttpMethod, type HostHttpRequest, type HostHttpRead } from './HostHttpTypes.js';
import { HostEnvironmentValidation } from './HostEnvironmentValidation.js';
import type { HostTerminalRequest, HostTerminalSnapshot } from './HostTerminalTypes.js';
import { HostOperationError } from './HostOperationError.js';
import { ConnectorHostErrorCode } from '../protocol/ConnectorHost.js';
import {
    HostDesktopPointerAction,
    HostDesktopButton,
    HostDesktopKeyAction,
    type HostDesktopPointerRequest,
    type HostDesktopKeyRequest,
} from './HostDesktopTypes.js';
import {
    HostShell,
    HostWriteMode,
    type HostProcessRequest,
    type HostProcessSnapshot,
    type HostProcessOutput,
} from './HostWorkspaceTypes.js';
import type {
    HostJsonObject,
    HostJsonValue,
    HostMcpTool,
    HostMcpTools,
} from './HostMcpProtocol.js';
import type { HostReadObservationStart } from './HostReadObservationStart.js';

/** Full-computer tools exposed to an explicitly authorized MCP stdio session. */
export class HostMcpWorkspaceTools implements HostMcpTools {
    /** Metadata is stable for the entire session; runtime authorization is checked on every operation. */
    public readonly tools: readonly HostMcpTool[];
    readonly #bounds: HostMcpWorkspaceBounds;

    /** The caller retains ownership of the host runtime and abort authority. */
    public constructor(
        public readonly workspace: HostWorkspace,
        public readonly signal: AbortSignal,
        bounds: HostMcpWorkspaceBounds = {
            maximumChunkBytes: 1048576,
            defaultChunkBytes: 65536,
            maximumDirectoryEntries: 1000,
        },
        terminalSupported: boolean = false,
    ) {
        if (
            !Number.isSafeInteger(bounds.maximumChunkBytes) ||
            bounds.maximumChunkBytes < 1 ||
            bounds.maximumChunkBytes > 1048576 ||
            !Number.isSafeInteger(bounds.defaultChunkBytes) ||
            bounds.defaultChunkBytes < 1 ||
            bounds.defaultChunkBytes > bounds.maximumChunkBytes ||
            !Number.isSafeInteger(bounds.maximumDirectoryEntries) ||
            bounds.maximumDirectoryEntries < 1 ||
            bounds.maximumDirectoryEntries > 1000
        ) {
            throw new Error('Invalid host tool transport bounds');
        }
        this.#bounds = Object.freeze({ ...bounds });
        this.tools = HostMcpWorkspaceCatalog.tools(bounds).filter(
            (tool: HostMcpTool): boolean => terminalSupported || !tool.name.startsWith('terminal_'),
        );
    }

    /** Validate each external tool shape before invoking the typed host operation. */
    public async call(
        name: string,
        argumentsValue: HostJsonObject,
        observation?: HostReadObservationStart,
    ): Promise<string> {
        this.signal.throwIfAborted();
        if (observation !== undefined && name !== 'process_start' && name !== 'terminal_start') {
            throw new Error('Native observation reservation requires an exact start');
        }
        const definition: HostMcpTool | undefined = this.tools.find(
            (entry: HostMcpTool): boolean => entry.name === name,
        );
        if (definition === undefined) {
            if (
                name.startsWith('terminal_') &&
                HostMcpWorkspaceCatalog.tools(this.#bounds).some(
                    (tool: HostMcpTool): boolean => tool.name === name,
                )
            ) {
                throw new HostOperationError(
                    ConnectorHostErrorCode.Unsupported,
                    'Native host terminal support is unavailable',
                    true,
                );
            }
            throw new Error('Unknown computer tool');
        }
        const properties: HostJsonValue | undefined = definition.inputSchema['properties'];
        if (properties === null || typeof properties !== 'object' || Array.isArray(properties)) {
            throw new Error('Invalid computer tool schema');
        }
        const args: Readonly<Record<string, unknown>> = this.#arguments(
            argumentsValue,
            Object.keys(properties),
            definition.inputSchema['required'],
        );
        switch (name) {
            case 'network_resolve':
                return this.#serialize({
                    addresses: await this.workspace.resolveNetwork(
                        this.#text(args['hostname']),
                        this.signal,
                    ),
                });
            case 'http_open':
                return this.#serialize(
                    await this.workspace.openHttp(this.#httpRequest(args), this.signal),
                );
            case 'http_read': {
                const read: HostHttpRead = await this.workspace.readHttp(
                    this.#text(args['transferId']),
                    this.#offset(args['offset']),
                    this.#maximum(args['maximumBytes']),
                );
                return this.#serialize({
                    transferId: read.transferId,
                    offset: read.offset.toString(),
                    nextOffset: read.nextOffset.toString(),
                    data: Buffer.from(read.bytes).toString('base64'),
                    encoding: 'base64',
                    state: read.state,
                    failure: read.failure,
                });
            }
            case 'http_close': {
                const transferId: string = this.#text(args['transferId']);
                await this.workspace.closeHttp(transferId);
                return this.#serialize({ transferId, closed: true });
            }
            case 'environment_inspect':
                return this.#serialize(
                    await this.workspace.inspectEnvironment(
                        HostEnvironmentValidation.request(args['programs'], args['variables']),
                        this.signal,
                    ),
                );
            case 'desktop_info':
                return this.#serialize(await this.workspace.desktopInfo());
            case 'desktop_screenshot': {
                const mode: HostWriteMode = this.#writeMode(args['mode']);
                if (mode !== HostWriteMode.Create && mode !== HostWriteMode.Replace) {
                    throw new Error('Desktop screenshots require create or replace');
                }
                return this.#serialize(
                    await this.workspace.desktopScreenshot(
                        this.#text(args['path']),
                        mode,
                        args['maximumWidth'] === undefined
                            ? 1920
                            : Boundary.count(args['maximumWidth'], 2048),
                        args['maximumHeight'] === undefined
                            ? 1080
                            : Boundary.count(args['maximumHeight'], 2048),
                    ),
                );
            }
            case 'desktop_pointer': {
                const request: HostDesktopPointerRequest = {
                    x: this.#coordinate(args['x']),
                    y: this.#coordinate(args['y']),
                    action: this.#choice(args['action'], Object.values(HostDesktopPointerAction)),
                    button:
                        args['button'] == null
                            ? null
                            : this.#choice(args['button'], Object.values(HostDesktopButton)),
                };
                await this.workspace.desktopPointer(request);
                return '{"sent":true}';
            }
            case 'desktop_key': {
                const request: HostDesktopKeyRequest = {
                    key: this.#text(args['key']),
                    action: this.#choice(args['action'], Object.values(HostDesktopKeyAction)),
                };
                await this.workspace.desktopKey(request);
                return '{"sent":true}';
            }
            case 'desktop_text':
                await this.workspace.desktopText(this.#text(args['text'], true));
                return '{"sent":true}';
            case 'computer_info':
                return this.#serialize(await SystemInfo.read(this.signal));
            case 'file_read': {
                const result: Awaited<ReturnType<HostWorkspace['read']>> =
                    await this.workspace.read(
                        this.#text(args['path']),
                        this.#offset(args['offset']),
                        this.#maximum(args['maximumBytes']),
                        args['snapshot'] === undefined
                            ? undefined
                            : HostFileSnapshotCodec.decode(args['snapshot']),
                        this.signal,
                    );
                return this.#serialize({
                    ...result,
                    bytes: undefined,
                    ...this.#bytes(result.bytes),
                });
            }
            case 'file_digest':
                return this.#serialize(
                    await this.workspace.digest(
                        this.#text(args['path']),
                        HostFileSnapshotCodec.decode(args['snapshot']),
                        this.signal,
                    ),
                );
            case 'file_write':
                return this.#serialize({
                    writtenBytes: await this.workspace.write(
                        this.#text(args['path']),
                        this.#input(args),
                        this.#writeMode(args['mode']),
                        this.#offset(args['offset']),
                    ),
                });
            case 'file_stat':
                return this.#serialize(
                    await this.workspace.stat(
                        this.#text(args['path']),
                        args['follow'] === undefined ? false : Boundary.boolean(args['follow']),
                    ),
                );
            case 'file_publish':
                await this.workspace.publish(
                    this.#text(args['source']),
                    this.#text(args['destination']),
                );
                return '{"published":true}';
            case 'file_rename':
                await this.workspace.rename(
                    this.#text(args['source']),
                    this.#text(args['destination']),
                );
                return '{"renamed":true}';
            case 'file_chmod':
                await this.workspace.chmod(
                    this.#text(args['path']),
                    Boundary.count(args['mode'], 0o7777),
                );
                return '{"changed":true}';
            case 'directory_list':
                return this.#serialize(
                    await this.workspace.list(
                        this.#text(args['path']),
                        args['offset'] === undefined ? 0 : Boundary.count(args['offset'], 1000000),
                        args['maximumEntries'] === undefined
                            ? Math.min(100, this.#bounds.maximumDirectoryEntries)
                            : Boundary.count(
                                  args['maximumEntries'],
                                  this.#bounds.maximumDirectoryEntries,
                              ),
                    ),
                );
            case 'directory_create':
                await this.workspace.mkdir(
                    this.#text(args['path']),
                    Boundary.boolean(args['recursive']),
                );
                return '{"created":true}';
            case 'file_remove':
                await this.workspace.remove(
                    this.#text(args['path']),
                    Boundary.boolean(args['recursive']),
                );
                return '{"removed":true}';
            case 'process_start':
                return this.#snapshot(
                    await this.workspace.start(
                        this.#process(args),
                        this.#bounds.defaultChunkBytes,
                        observation,
                    ),
                );
            case 'process_read':
                return this.#snapshot(
                    await this.workspace.output(
                        this.#text(args['processId']),
                        this.#offset(args['stdoutOffset']),
                        this.#offset(args['stderrOffset']),
                        this.#maximum(args['maximumBytes']),
                    ),
                );
            case 'process_write':
                await this.workspace.input(
                    this.#text(args['processId']),
                    this.#input(args),
                    Boundary.boolean(args['end']),
                );
                return '{"accepted":true}';
            case 'process_stop':
                await this.workspace.stop(this.#text(args['processId']));
                return '{"stopped":true}';
            case 'process_release':
                await this.workspace.release(this.#text(args['processId']));
                return '{"released":true}';
            case 'terminal_start': {
                const request: HostTerminalRequest = {
                    ...this.#process(args),
                    cols: Boundary.count(args['cols'], 500),
                    rows: Boundary.count(args['rows'], 200),
                };
                return this.#terminal(
                    await this.workspace.terminals.start(
                        request,
                        this.#bounds.defaultChunkBytes,
                        observation,
                    ),
                );
            }
            case 'terminal_read':
                return this.#terminal(
                    await this.workspace.terminals.output(
                        this.#text(args['processId']),
                        this.#offset(args['offset']),
                        this.#maximum(args['maximumBytes']),
                    ),
                );
            case 'terminal_write':
                await this.workspace.terminals.input(
                    this.#text(args['processId']),
                    this.#input(args),
                );
                return '{"accepted":true}';
            case 'terminal_resize':
                await this.workspace.terminals.resize(
                    this.#text(args['processId']),
                    Boundary.count(args['cols'], 500),
                    Boundary.count(args['rows'], 200),
                );
                return '{"resized":true}';
            case 'terminal_stop':
                await this.workspace.terminals.stop(this.#text(args['processId']));
                return '{"stopped":true}';
            case 'terminal_release':
                await this.workspace.terminals.release(this.#text(args['processId']));
                return '{"released":true}';
            default:
                throw new Error('Unknown computer tool');
        }
    }

    #arguments(
        value: HostJsonObject,
        fields: readonly string[],
        required: HostJsonValue | undefined,
    ): Readonly<Record<string, unknown>> {
        try {
            const args: Readonly<Record<string, unknown>> = Boundary.record(value, fields);
            for (const field of Boundary.array(required, 32)) {
                if (typeof field !== 'string' || !Object.hasOwn(args, field)) {
                    throw new Error('Missing required host operation argument');
                }
            }
            return args;
        } catch (cause: unknown) {
            throw new HostOperationError(
                ConnectorHostErrorCode.InvalidRequest,
                'Host operation arguments were rejected before execution',
                true,
                { cause },
            );
        }
    }

    #process(args: Readonly<Record<string, unknown>>): HostProcessRequest {
        try {
            const request: HostProcessRequest = this.#processRequest(args);
            HostWorkspaceValidation.process(request);
            return request;
        } catch (cause: unknown) {
            throw new HostOperationError(
                ConnectorHostErrorCode.InvalidRequest,
                'Host launch arguments were rejected before execution',
                true,
                { cause },
            );
        }
    }

    #httpRequest(args: Readonly<Record<string, unknown>>): HostHttpRequest {
        const headers: Readonly<Record<string, unknown>> = this.#environment(args['headers']);
        return {
            url: this.#text(args['url']),
            address: this.#text(args['address']),
            method: this.#choice(args['method'], Object.values(HostHttpMethod)),
            headers: Object.fromEntries(
                Object.entries(headers).map(([key, value]: [string, unknown]): [string, string] => [
                    key,
                    this.#text(value, true),
                ]),
            ),
            maximumBytes: this.#offset(args['maximumBytes']),
            timeoutMs: Boundary.count(args['timeoutMs'], 900000),
            idleTimeoutMs: Boundary.count(args['idleTimeoutMs'], 30000),
        };
    }

    #processRequest(args: Readonly<Record<string, unknown>>): HostProcessRequest {
        const environment: Readonly<Record<string, unknown>> = this.#environment(
            args['environment'] ?? {},
        );
        const entries: [string, string][] = Object.entries(environment).map(
            ([key, value]: [string, unknown]): [string, string] => [key, this.#text(value, true)],
        );
        const shell: unknown = args['shell'] ?? null;
        if (
            shell !== null &&
            !Object.values(HostShell).some((value: HostShell): boolean => value === shell)
        ) {
            throw new Error('Invalid shell');
        }
        return {
            executable: args['executable'] == null ? null : this.#text(args['executable']),
            arguments: Boundary.array(args['arguments'] ?? [], 256).map((value: unknown): string =>
                this.#text(value, true),
            ),
            shell: shell as HostShell | null,
            command: args['command'] == null ? null : this.#text(args['command']),
            directory: args['directory'] == null ? null : this.#text(args['directory']),
            environment: Object.fromEntries(entries),
            timeoutMs: Boundary.count(args['timeoutMs'], 604800000),
            ...(args['retentionAfterTimeoutMs'] === undefined
                ? {}
                : {
                      retentionAfterTimeoutMs: Boundary.count(
                          args['retentionAfterTimeoutMs'],
                          86400000,
                      ),
                  }),
        };
    }

    #environment(raw: unknown): Readonly<Record<string, unknown>> {
        if (
            raw === null ||
            typeof raw !== 'object' ||
            Array.isArray(raw) ||
            Object.keys(raw).length > 256
        ) {
            throw new Error('Invalid process environment');
        }
        return Boundary.record(raw, Object.keys(raw));
    }

    #input(args: Readonly<Record<string, unknown>>): Buffer {
        const raw: unknown = args['data'];
        if (typeof raw !== 'string' || raw.length > 196608) {
            throw new Error('Invalid computer operation bytes');
        }
        const data: string = raw;
        if (args['encoding'] === 'utf8') {
            const bytes: Buffer = Buffer.from(data, 'utf8');
            if (bytes.byteLength > this.#bounds.maximumChunkBytes) {
                throw new Error('Host input exceeds the transport chunk bound');
            }
            return bytes;
        }
        if (args['encoding'] !== 'base64') {
            throw new Error('Invalid byte encoding');
        }
        const bytes: Buffer = Buffer.from(data, 'base64');
        if (
            bytes.toString('base64') !== data ||
            bytes.byteLength > this.#bounds.maximumChunkBytes
        ) {
            throw new Error('Invalid canonical base64');
        }
        return bytes;
    }

    #text(raw: unknown, empty: boolean = false): string {
        if (
            typeof raw !== 'string' ||
            (!empty && raw.length === 0) ||
            raw.length > 196608 ||
            raw.includes('\0')
        ) {
            throw new Error('Invalid computer operation text');
        }
        return raw;
    }

    #offset(raw: unknown): bigint {
        return raw === undefined ? 0n : Boundary.integer(raw);
    }
    #choice<T extends string>(raw: unknown, choices: readonly T[]): T {
        for (const choice of choices) {
            if (choice === raw) {
                return choice;
            }
        }
        throw new Error('Invalid desktop action');
    }
    #coordinate(raw: unknown): number {
        if (typeof raw !== 'number' || !Number.isSafeInteger(raw) || Math.abs(raw) > 1000000) {
            throw new Error('Invalid desktop coordinate');
        }
        return raw;
    }
    #maximum(raw: unknown): number {
        return raw === undefined
            ? this.#bounds.defaultChunkBytes
            : Boundary.count(raw, this.#bounds.maximumChunkBytes);
    }
    #writeMode(raw: unknown): HostWriteMode {
        for (const mode of Object.values(HostWriteMode)) {
            if (raw === mode) {
                return mode;
            }
        }
        throw new Error('Explicit file write mode required');
    }

    #bytes(bytes: Buffer): HostJsonObject {
        try {
            const data: string = new TextDecoder('utf-8', { fatal: true }).decode(bytes);
            if (
                this.#bounds.compactEncodedBytes === true &&
                Buffer.byteLength(JSON.stringify(data)) > Math.ceil(bytes.byteLength / 3) * 4 + 2
            ) {
                return { encoding: 'base64', data: bytes.toString('base64') };
            }
            return {
                encoding: 'utf8',
                data,
            };
        } catch {
            return { encoding: 'base64', data: bytes.toString('base64') };
        }
    }

    #stream(stream: HostProcessOutput): HostJsonObject {
        return {
            offset: stream.offset.toString(),
            nextOffset: stream.nextOffset.toString(),
            endOffset: stream.endOffset.toString(),
            truncated: stream.truncated,
            ...this.#bytes(stream.bytes),
        };
    }

    #snapshot(snapshot: HostProcessSnapshot): string {
        return this.#serialize({
            ...snapshot,
            stdout: this.#stream(snapshot.stdout),
            stderr: this.#stream(snapshot.stderr),
        });
    }

    #terminal(snapshot: HostTerminalSnapshot): string {
        return this.#serialize({ ...snapshot, output: this.#stream(snapshot.output) });
    }

    #serialize<T>(value: T): string {
        return JSON.stringify(value, (_key: string, item: unknown): unknown =>
            typeof item === 'bigint' ? item.toString() : item,
        );
    }
}
