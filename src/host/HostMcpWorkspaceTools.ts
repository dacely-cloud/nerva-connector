// SPDX-FileCopyrightText: 2026 Dacely <business@dacely.com>
// SPDX-License-Identifier: LicenseRef-Proprietary

import {
    ConnectorHostErrorCode,
    ConnectorHostTool,
} from 'nerva-connector-protocol/protocol/ConnectorHost.js';
import type { ConnectorHostArgumentBounds } from 'nerva-connector-protocol/protocol/ConnectorHostArgumentContract.js';
import {
    ConnectorHostByteEncoding,
    ConnectorHostHttpMethod,
    ConnectorHostKeyAction,
    ConnectorHostPointerAction,
    ConnectorHostPointerButton,
    ConnectorHostShell,
    ConnectorHostWriteMode,
} from 'nerva-connector-protocol/protocol/ConnectorHostArgumentChoices.js';
import type { ConnectorHostArguments } from 'nerva-connector-protocol/protocol/ConnectorHostArguments.js';
import {
    ConnectorHostArgumentValidation,
    type ConnectorHostArgumentCheck,
} from 'nerva-connector-protocol/protocol/ConnectorHostArgumentValidation.js';
import { SystemInfo } from '../system/SystemInfo.js';
import { HostFileSnapshotCodec } from './HostFileSnapshotCodec.js';
import { HostWorkspace } from './HostWorkspace.js';
import { HostWorkspaceValidation } from './HostWorkspaceValidation.js';
import { HostMcpWorkspaceCatalog } from './HostMcpWorkspaceCatalog.js';
import { HostDesktopCoordinates } from './HostDesktopCoordinates.js';
import type { HostHttpRead } from './HostHttpTypes.js';
import type { HostTerminalRequest, HostTerminalSnapshot } from './HostTerminalTypes.js';
import { HostOperationError } from './HostOperationError.js';
import {
    HostDesktopLimits,
    type HostDesktopPointerRequest,
    type HostDesktopKeyRequest,
    type HostDesktopTextField,
} from './HostDesktopTypes.js';
import type {
    HostProcessRequest,
    HostProcessSnapshot,
    HostProcessOutput,
} from './HostWorkspaceTypes.js';
import type { HostJsonObject, HostMcpTool, HostMcpTools } from './HostMcpProtocol.js';
import type { HostMcpWorkspaceBounds } from './HostMcpWorkspaceBounds.js';
import type { HostReadObservationStart } from './HostReadObservationStart.js';

/**
 * Full-computer tools exposed to an explicitly authorized MCP stdio session.
 *
 * @remarks
 * Every call's arguments are checked against the tool's argument contract from nerva-connector-protocol before any
 * host operation is invoked, and a violation is a definitive invalid request naming the field. Remote clients check
 * the same contracts before submitting, but this check never relies on that.
 */
export class HostMcpWorkspaceTools implements HostMcpTools {
    /** Metadata is stable for the entire session; runtime authorization is checked on every operation. */
    public readonly tools: readonly HostMcpTool[];
    readonly #bounds: HostMcpWorkspaceBounds;
    readonly #argumentBounds: ConnectorHostArgumentBounds;

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
        this.#argumentBounds = Object.freeze(HostMcpWorkspaceCatalog.argumentBounds(bounds));
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
        if (
            observation !== undefined &&
            name !== ConnectorHostTool.ProcessStart &&
            name !== ConnectorHostTool.TerminalStart
        ) {
            throw new HostOperationError(
                ConnectorHostErrorCode.InvalidRequest,
                'Native observation reservation requires an exact start',
                true,
            );
        }
        const known: ConnectorHostTool | undefined = Object.values(ConnectorHostTool).find(
            (tool: ConnectorHostTool): boolean => tool === name,
        );
        if (
            known === undefined ||
            !this.tools.some((tool: HostMcpTool): boolean => tool.name === known)
        ) {
            if (known !== undefined && known.startsWith('terminal_')) {
                throw new HostOperationError(
                    ConnectorHostErrorCode.Unsupported,
                    'Native host terminal support is unavailable',
                    true,
                );
            }
            throw this.#unsupported();
        }
        const check: ConnectorHostArgumentCheck = ConnectorHostArgumentValidation.check(
            known,
            argumentsValue,
            this.#argumentBounds,
        );
        if (!check.valid) {
            throw new HostOperationError(
                ConnectorHostErrorCode.InvalidRequest,
                check.message,
                true,
            );
        }
        return await this.#dispatch(known, check.arguments, observation);
    }

    async #dispatch(
        tool: ConnectorHostTool,
        args: ConnectorHostArguments,
        observation: HostReadObservationStart | undefined,
    ): Promise<string> {
        switch (tool) {
            case ConnectorHostTool.NetworkResolve:
                return this.#serialize({
                    addresses: await this.workspace.resolveNetwork(
                        args.text('hostname'),
                        this.signal,
                    ),
                });
            case ConnectorHostTool.HttpOpen:
                return this.#serialize(
                    await this.workspace.openHttp(
                        {
                            url: args.text('url'),
                            address: args.text('address'),
                            method: args.choice('method', Object.values(ConnectorHostHttpMethod)),
                            headers: args.map('headers'),
                            maximumBytes: args.decimal('maximumBytes'),
                            timeoutMs: args.integer('timeoutMs'),
                            idleTimeoutMs: args.integer('idleTimeoutMs'),
                        },
                        this.signal,
                    ),
                );
            case ConnectorHostTool.HttpRead: {
                const read: HostHttpRead = await this.workspace.readHttp(
                    args.text('transferId'),
                    args.decimal('offset'),
                    args.integer('maximumBytes'),
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
            case ConnectorHostTool.HttpClose: {
                const transferId: string = args.text('transferId');
                await this.workspace.closeHttp(transferId);
                return this.#serialize({ transferId, closed: true });
            }
            case ConnectorHostTool.EnvironmentInspect:
                return this.#serialize(
                    await this.workspace.inspectEnvironment(
                        { programs: args.list('programs'), variables: args.list('variables') },
                        this.signal,
                    ),
                );
            case ConnectorHostTool.DesktopInfo:
                return this.#serialize(await this.workspace.desktopInfo());
            case ConnectorHostTool.ApplicationOpen:
                return this.#serialize(
                    await this.workspace.openApplication(
                        args.text('name'),
                        args.optionalText('url', undefined),
                        args.optionalText('workspaceFile', undefined),
                    ),
                );
            case ConnectorHostTool.DesktopSnapshot:
                return this.#serialize(await this.workspace.desktopSnapshot());
            case ConnectorHostTool.DesktopScreenshot:
                return this.#serialize(
                    await this.workspace.desktopScreenshot(
                        args.text('path'),
                        args.choice('mode', [
                            ConnectorHostWriteMode.Create,
                            ConnectorHostWriteMode.Replace,
                        ]),
                        args.optionalInteger('maximumWidth', HostDesktopLimits.dimension),
                        args.optionalInteger('maximumHeight', HostDesktopLimits.dimension),
                    ),
                );
            case ConnectorHostTool.DesktopPointer: {
                const action: ConnectorHostPointerAction = args.choice(
                    'action',
                    Object.values(ConnectorHostPointerAction),
                );
                const request: HostDesktopPointerRequest = {
                    x: args.integer('x'),
                    y: args.integer('y'),
                    action,
                    button:
                        !args.present('button') && action !== ConnectorHostPointerAction.Move
                            ? ConnectorHostPointerButton.Left
                            : args.optionalChoice(
                                  'button',
                                  Object.values(ConnectorHostPointerButton),
                                  null,
                              ),
                };
                const image: ConnectorHostArguments | null = args.optionalRecord('image');
                await this.workspace.desktopPointer(
                    request,
                    image === null ? null : HostDesktopCoordinates.read(image),
                );
                return '{"sent":true}';
            }
            case ConnectorHostTool.DesktopKey: {
                const target: string | undefined = args.optionalText('target', undefined);
                const request: HostDesktopKeyRequest = {
                    key: args.text('key'),
                    action: args.choice('action', Object.values(ConnectorHostKeyAction)),
                    ...(target === undefined ? {} : { target }),
                };
                await this.workspace.desktopKey(request);
                return '{"sent":true}';
            }
            case ConnectorHostTool.DesktopText: {
                const field: HostDesktopTextField | undefined = args.has('field')
                    ? { field: args.text('field'), replace: true }
                    : undefined;
                await this.workspace.desktopText(
                    args.text('text'),
                    args.optionalText('target', undefined),
                    field,
                );
                return field === undefined
                    ? '{"sent":true}'
                    : '{"sent":true,"replaced":true,"verified":true}';
            }
            case ConnectorHostTool.ComputerInfo:
                return this.#serialize(await SystemInfo.read(this.signal));
            case ConnectorHostTool.FileRead: {
                const snapshot: ConnectorHostArguments | null = args.optionalRecord('snapshot');
                const result: Awaited<ReturnType<HostWorkspace['read']>> =
                    await this.workspace.read(
                        args.text('path'),
                        args.optionalDecimal('offset', 0n),
                        args.optionalInteger('maximumBytes', this.#bounds.defaultChunkBytes),
                        snapshot === null ? undefined : HostFileSnapshotCodec.decode(snapshot),
                        this.signal,
                    );
                return this.#serialize({
                    ...result,
                    bytes: undefined,
                    ...this.#bytes(result.bytes),
                });
            }
            case ConnectorHostTool.FileDigest:
                return this.#serialize(
                    await this.workspace.digest(
                        args.text('path'),
                        HostFileSnapshotCodec.decode(args.record('snapshot')),
                        this.signal,
                    ),
                );
            case ConnectorHostTool.FileWrite:
                return this.#serialize({
                    writtenBytes: await this.workspace.write(
                        args.text('path'),
                        this.#input(args),
                        args.choice('mode', Object.values(ConnectorHostWriteMode)),
                        args.optionalDecimal('offset', 0n),
                    ),
                });
            case ConnectorHostTool.FileStat:
                return this.#serialize(
                    await this.workspace.stat(
                        args.text('path'),
                        args.optionalBoolean('follow', false),
                    ),
                );
            case ConnectorHostTool.FilePublish:
                await this.workspace.publish(args.text('source'), args.text('destination'));
                return '{"published":true}';
            case ConnectorHostTool.FileRename:
                await this.workspace.rename(args.text('source'), args.text('destination'));
                return '{"renamed":true}';
            case ConnectorHostTool.FileChmod:
                await this.workspace.chmod(args.text('path'), args.integer('mode'));
                return '{"changed":true}';
            case ConnectorHostTool.DirectoryList:
                return this.#serialize(
                    await this.workspace.list(
                        args.text('path'),
                        args.optionalInteger('offset', 0),
                        args.optionalInteger(
                            'maximumEntries',
                            Math.min(100, this.#bounds.maximumDirectoryEntries),
                        ),
                    ),
                );
            case ConnectorHostTool.DirectoryCreate:
                await this.workspace.mkdir(args.text('path'), args.boolean('recursive'));
                return '{"created":true}';
            case ConnectorHostTool.FileRemove:
                await this.workspace.remove(args.text('path'), args.boolean('recursive'));
                return '{"removed":true}';
            case ConnectorHostTool.ProcessStart:
                return this.#snapshot(
                    await this.workspace.start(
                        this.#process(args),
                        this.#bounds.defaultChunkBytes,
                        observation,
                    ),
                );
            case ConnectorHostTool.ProcessRead:
                return this.#snapshot(
                    await this.workspace.output(
                        args.text('processId'),
                        args.optionalDecimal('stdoutOffset', 0n),
                        args.optionalDecimal('stderrOffset', 0n),
                        args.optionalInteger('maximumBytes', this.#bounds.defaultChunkBytes),
                    ),
                );
            case ConnectorHostTool.ProcessWrite:
                await this.workspace.input(
                    args.text('processId'),
                    this.#input(args),
                    args.boolean('end'),
                );
                return '{"accepted":true}';
            case ConnectorHostTool.ProcessStop:
                await this.workspace.stop(args.text('processId'));
                return '{"stopped":true}';
            case ConnectorHostTool.ProcessRelease:
                await this.workspace.release(args.text('processId'));
                return '{"released":true}';
            case ConnectorHostTool.TerminalStart: {
                const request: HostTerminalRequest = {
                    ...this.#process(args),
                    cols: args.integer('cols'),
                    rows: args.integer('rows'),
                };
                return this.#terminal(
                    await this.workspace.terminals.start(
                        request,
                        this.#bounds.defaultChunkBytes,
                        observation,
                    ),
                );
            }
            case ConnectorHostTool.TerminalRead:
                return this.#terminal(
                    await this.workspace.terminals.output(
                        args.text('processId'),
                        args.optionalDecimal('offset', 0n),
                        args.optionalInteger('maximumBytes', this.#bounds.defaultChunkBytes),
                    ),
                );
            case ConnectorHostTool.TerminalWrite:
                await this.workspace.terminals.input(args.text('processId'), this.#input(args));
                return '{"accepted":true}';
            case ConnectorHostTool.TerminalResize:
                await this.workspace.terminals.resize(
                    args.text('processId'),
                    args.integer('cols'),
                    args.integer('rows'),
                );
                return '{"resized":true}';
            case ConnectorHostTool.TerminalStop:
                await this.workspace.terminals.stop(args.text('processId'));
                return '{"stopped":true}';
            case ConnectorHostTool.TerminalRelease:
                await this.workspace.terminals.release(args.text('processId'));
                return '{"released":true}';
            default:
                throw this.#unsupported();
        }
    }

    #unsupported(): HostOperationError {
        return new HostOperationError(
            ConnectorHostErrorCode.Unsupported,
            'This Connector does not offer the requested computer tool',
            true,
        );
    }

    /**
     * Launch fields already satisfy the contract; the typed request check also bounds their combined size.
     *
     * @remarks
     * `null` and absence mean the same for every launch field, and an absent argument list or environment is empty.
     */
    #process(args: ConnectorHostArguments): HostProcessRequest {
        const retention: number | undefined = args.optionalInteger(
            'retentionAfterTimeoutMs',
            undefined,
        );
        const request: HostProcessRequest = {
            executable: args.optionalText('executable', null),
            arguments: args.list('arguments'),
            shell: args.optionalChoice('shell', Object.values(ConnectorHostShell), null),
            command: args.optionalText('command', null),
            directory: args.optionalText('directory', null),
            environment: args.map('environment'),
            timeoutMs: args.integer('timeoutMs'),
            ...(retention === undefined ? {} : { retentionAfterTimeoutMs: retention }),
        };
        try {
            HostWorkspaceValidation.process(request);
            return request;
        } catch (cause: unknown) {
            if (cause instanceof HostOperationError) {
                throw cause;
            }
            throw new HostOperationError(
                ConnectorHostErrorCode.InvalidRequest,
                'Host launch arguments were rejected before execution',
                true,
                { cause },
            );
        }
    }

    /** The contract has already checked the encoding and the decoded size against the transport chunk. */
    #input(args: ConnectorHostArguments): Buffer {
        return Buffer.from(
            args.text('data'),
            args.choice('encoding', Object.values(ConnectorHostByteEncoding)),
        );
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
