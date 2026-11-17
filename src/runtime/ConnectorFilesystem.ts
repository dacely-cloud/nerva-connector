// SPDX-FileCopyrightText: 2026 Nerva contributors
// SPDX-License-Identifier: LicenseRef-Proprietary

import type { FileHandle } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { resolve } from 'node:path';
import { Boundary } from 'nerva-connector-protocol/protocol/Boundary.js';
import { ConnectorFilesCodec } from 'nerva-connector-protocol/protocol/ConnectorFilesCodec.js';
import { ConnectorUploadCodec } from 'nerva-connector-protocol/protocol/ConnectorUploadCodec.js';
import { ConnectorUploadLimits } from 'nerva-connector-protocol/protocol/ConnectorUpload.js';
import {
    ConnectorFileFailure,
    ConnectorFileLimits,
    ConnectorFileMode,
    type ConnectorFileProfile,
    type ConnectorFileRequest,
    type ConnectorFileDescribe,
    type ConnectorFileResponse,
} from 'nerva-connector-protocol/protocol/ConnectorFiles.js';
import { ConnectorFileKind } from 'nerva-connector-protocol/protocol/ConnectorFileTypes.js';
import { ConnectorFileAction } from 'nerva-connector-protocol/protocol/ConnectorFileTypes.js';
import { ConnectorNativeExecutable } from './ConnectorNativeExecutable.js';
import { ProtectedFiles } from '../local/ProtectedFiles.js';
import {
    ConnectorFileRoots,
    type ConnectorFileRootCapability,
    type ConnectorFileRootPolicy,
} from './ConnectorFileRoots.js';
import {
    ConnectorFilesystemProcess,
    type ConnectorNativeOutcome,
} from './ConnectorFilesystemProcess.js';
import type { WorkspaceInspection } from '../workspace/WorkspaceInspection.js';
import { ConnectorFileStageQuiescence } from './ConnectorFileStageQuiescence.js';
import { ConnectorFileStageInspector } from './ConnectorFileStageInspector.js';
import { ConnectorFilePolicy, type ConnectorFilePolicyDefinition } from './ConnectorFilePolicy.js';
import { WorkspaceIdentityProcess } from '../workspace/WorkspaceIdentityProcess.js';
import {
    ConnectorEffectKind,
    type ConnectorCapturedFileEffect,
    type ConnectorNativeFileEffect,
} from './ConnectorEffectContext.js';

/** Local administrator policy selects pinned directory capabilities; requests cannot select executables or absolute roots. */
export class ConnectorFilesystem implements AsyncDisposable {
    readonly #process: ConnectorFilesystemProcess;
    readonly #executable: FileHandle;
    readonly #roots: ConnectorFileRoots;
    readonly #inspections: Set<Promise<undefined>> = new Set();
    readonly #inspectionStop: AbortController = new AbortController();
    readonly #capture: WorkspaceIdentityProcess = new WorkspaceIdentityProcess();
    readonly #effects: Map<ConnectorFileRootCapability, Promise<ConnectorNativeFileEffect>> =
        new Map();

    #closed: boolean = false;
    private constructor(
        public readonly profile: ConnectorFileProfile,
        executable: FileHandle,
        roots: ConnectorFileRoots,
    ) {
        this.#executable = executable;
        this.#process = new ConnectorFilesystemProcess(executable, profile.mode);
        this.#roots = roots;
        Object.freeze(this);
    }

    /** Verify the helper's exact bytes and retain opened directories instead of reopening mutable names for requests. */
    public static async load(
        path: string,
        privatePaths: readonly string[],
        expectedPolicySha256?: string,
    ): Promise<ConnectorFilesystem> {
        if (process.platform !== 'linux') {
            throw new Error('Connector filesystem requires the qualified Linux helper');
        }
        let executable: FileHandle | null = null;
        let roots: ConnectorFileRoots | null = null;
        let owner: ConnectorFilesystem | null = null;
        try {
            const definition: ConnectorFilePolicyDefinition = await ConnectorFilePolicy.load(path);
            if (
                expectedPolicySha256 !== undefined &&
                ConnectorFilePolicy.commitment(definition) !== expectedPolicySha256
            ) {
                throw new Error('Original file policy changed before resource acquisition');
            }
            const { mode, revision, helperFile, helperSha256 }: ConnectorFilePolicyDefinition =
                definition;
            const protectedPaths: readonly string[] = [path, helperFile, ...privatePaths].map(
                (entry: string): string => {
                    const absolute: string = ProtectedFiles.path(entry);
                    if (resolve(absolute) !== absolute) {
                        throw new Error('Canonical private connector references required');
                    }
                    return absolute;
                },
            );
            executable = await ConnectorNativeExecutable.open(helperFile, helperSha256);
            await ConnectorNativeExecutable.assertRunnable(executable);
            roots = await ConnectorFileRoots.open(definition.roots, protectedPaths);
            const profile: ConnectorFileProfile = Object.freeze({
                mode,
                revision,
                roots: Object.freeze(
                    roots.policies.map((root: ConnectorFileRootPolicy): string => root.id),
                ),
                maximumReadBytes: ConnectorFileLimits.readBytes,
                maximumWriteBytes:
                    mode === ConnectorFileMode.ReadWrite ? ConnectorFileLimits.writeBytes : 0,
                policySha256: ConnectorFilePolicy.commitment(definition),
            });
            const service: ConnectorFilesystem = new ConnectorFilesystem(
                profile,
                executable,
                roots,
            );
            owner = service;
            for (const root of roots.policies) {
                const response: ConnectorFileResponse = await service.#execute({
                    action: ConnectorFileAction.Stat,
                    requestId: 'root-probe',
                    rootId: root.id,
                    path: '.',
                    policySha256: profile.policySha256,
                });
                if (
                    !response.ok ||
                    response.result.action !== ConnectorFileAction.Stat ||
                    response.result.metadata.kind !== ConnectorFileKind.Directory
                ) {
                    throw new Error('Connector root confinement unavailable');
                }
            }
            return service;
        } catch (caught: unknown) {
            if (owner !== null) {
                await owner[Symbol.asyncDispose]();
            } else {
                await roots?.[Symbol.asyncDispose]();
                await executable?.close();
            }
            throw caught;
        }
    }

    /** A bounded JSON entry point validates unknown input before touching any directory. */
    public async dispatch(json: string, stagingId?: string): Promise<ConnectorFileResponse> {
        return await this.#dispatch(json, stagingId);
    }

    /** A server-owned effect uses private original provenance in addition to the public policy request. */
    public async dispatchBound(
        json: string,
        stagingId: string | undefined,
        effect: ConnectorCapturedFileEffect,
    ): Promise<ConnectorFileResponse> {
        return await this.#dispatch(json, stagingId, effect);
    }

    /** Single-flight capture is keyed by the owned capability object, never a reused FD number or pathname. */
    public async effectContext(rootId: string): Promise<ConnectorCapturedFileEffect> {
        const root: ConnectorFileRootCapability | undefined = this.#roots.capabilities.get(rootId);
        if (this.#closed || root === undefined) {
            throw new Error('Physical file capture unavailable');
        }
        let pending: Promise<ConnectorNativeFileEffect> | undefined = this.#effects.get(root);
        if (pending === undefined) {
            pending = this.#capture.fileEffect({
                descriptor: root.directory.fd,
                helperDescriptor: this.#executable.fd,
                stagingDescriptor: root.staging?.fd ?? null,
                signal: this.#inspectionStop.signal,
            });
            this.#effects.set(root, pending);
        }
        const captured: ConnectorNativeFileEffect = await pending;
        if (this.#closed) {
            throw new Error('Physical file capture closed');
        }
        return Object.freeze({
            kind: ConnectorEffectKind.CapturedFile,
            policySha256: this.profile.policySha256,
            rootId,
            root: captured.root,
            staging: captured.staging,
        });
    }

    async #dispatch(
        json: string,
        stagingId?: string,
        effect?: ConnectorCapturedFileEffect,
    ): Promise<ConnectorFileResponse> {
        try {
            if (
                json.length > ConnectorUploadLimits.requestBytes ||
                Buffer.byteLength(json) > ConnectorUploadLimits.requestBytes
            ) {
                throw new Error('Connector file input exceeds policy');
            }
            const raw: unknown = JSON.parse(json);
            const request: ConnectorFileRequest = ConnectorFilesCodec.request(raw);
            if (request.action === ConnectorFileAction.Describe) {
                return this.#closed
                    ? { ok: false, error: ConnectorFileFailure.Unavailable }
                    : { ok: true, result: { ...request, profile: this.profile } };
            }
            if (
                effect !== undefined &&
                (request.rootId !== effect.rootId || request.policySha256 !== effect.policySha256)
            ) {
                return { ok: false, error: ConnectorFileFailure.Changed };
            }
            return await this.#execute(request, stagingId, effect);
        } catch {
            return { ok: false, error: ConnectorFileFailure.Invalid };
        }
    }

    /** Recovery removes only the original device-derived staging name; it never repeats a write. */
    public async cleanupWrite(
        request: Exclude<ConnectorFileRequest, ConnectorFileDescribe>,
        stagingId: string,
        effect?: ConnectorCapturedFileEffect,
    ): Promise<void> {
        if (request.action !== ConnectorFileAction.Write) {
            return;
        }
        const root: ConnectorFileRootCapability | undefined = this.#roots.capabilities.get(
            request.rootId,
        );
        if (
            this.#closed ||
            root?.staging === null ||
            root === undefined ||
            request.policySha256 !== this.profile.policySha256 ||
            !/^[a-f0-9]{64}$/u.test(stagingId) ||
            (effect !== undefined &&
                (effect.rootId !== request.rootId ||
                    effect.policySha256 !== request.policySha256 ||
                    effect.staging === null))
        ) {
            throw new Error('Original write staging capability unavailable');
        }
        const outcome: ConnectorNativeOutcome<boolean> = await this.#process.run(
            root,
            JSON.stringify({ action: 'cleanup-write', stagingId }),
            (raw: unknown): boolean => {
                const value: Readonly<Record<string, unknown>> = Boundary.record(raw, [
                    'ok',
                    'result',
                ]);
                const result: Readonly<Record<string, unknown>> = Boundary.record(value['result'], [
                    'action',
                    'removed',
                ]);
                if (value['ok'] !== true || result['action'] !== 'cleanup-write') {
                    throw new Error('Native write cleanup failed');
                }
                return Boundary.boolean(result['removed']);
            },
            true,
            effect === undefined ? undefined : { root: effect.root, staging: effect.staging },
        );
        if (!outcome.ok) {
            throw new Error('Original write cleanup could not be verified');
        }
    }

    /** Local inspection borrows only a selected root and verified helper until the callback's actual completion. */
    public async inspectWorkspace<T>(
        rootId: string,
        inspect: (root: WorkspaceInspection) => Promise<T>,
        signal: AbortSignal,
    ): Promise<T> {
        signal.throwIfAborted();
        const root: ConnectorFileRootCapability | undefined = this.#roots.capabilities.get(rootId);
        if (
            this.#closed ||
            root === undefined ||
            this.#inspections.size >= ConnectorFileLimits.children
        ) {
            throw new Error('Local workspace inspection is unavailable');
        }
        const finished: PromiseWithResolvers<undefined> = Promise.withResolvers<undefined>();
        this.#inspections.add(finished.promise);
        const combined: AbortSignal = AbortSignal.any([signal, this.#inspectionStop.signal]);
        try {
            combined.throwIfAborted();
            const result: T = await inspect({
                descriptor: root.directory.fd,
                helperDescriptor: this.#executable.fd,
                access: this.profile.mode,
                signal: combined,
            });
            combined.throwIfAborted();
            return result;
        } finally {
            this.#inspections.delete(finished.promise);
            finished.resolve(undefined);
        }
    }

    /** Only captured current stages are observed; uploads and unknown content are retained rather than aborted. */
    public async preparationStages(signal: AbortSignal): Promise<ConnectorFileStageQuiescence> {
        if (this.#closed || signal.aborted) {
            return ConnectorFileStageQuiescence.Unknown;
        }
        for (const policy of this.#roots.policies) {
            const root: ConnectorFileRootCapability | undefined = this.#roots.capabilities.get(
                policy.id,
            );
            if (root === undefined) {
                return ConnectorFileStageQuiescence.Unknown;
            }
            if (root.staging === null) {
                continue;
            }
            const state: ConnectorFileStageQuiescence = await ConnectorFileStageInspector.inspect(
                this.#process,
                root,
                policy.path,
                this.profile.policySha256,
                signal,
            );
            if (signal.aborted || this.#closed) {
                return ConnectorFileStageQuiescence.Unknown;
            }
            if (state !== ConnectorFileStageQuiescence.Quiescent) {
                return state;
            }
        }
        return ConnectorFileStageQuiescence.Quiescent;
    }

    /** The service retains capacity until exact child close; cancellation never pretends a live kernel task has exited. */
    public async [Symbol.asyncDispose](): Promise<void> {
        this.#closed = true;
        this.#inspectionStop.abort();
        await Promise.all([
            this.#process[Symbol.asyncDispose](),
            this.#capture[Symbol.asyncDispose](),
            ...this.#inspections,
        ]);
        await this.#roots[Symbol.asyncDispose]();
        await this.#executable.close();
    }

    async #execute(
        request: Exclude<ConnectorFileRequest, ConnectorFileDescribe>,
        stagingId?: string,
        effect?: ConnectorCapturedFileEffect,
    ): Promise<ConnectorFileResponse> {
        if (this.#closed) {
            return { ok: false, error: ConnectorFileFailure.Unavailable };
        }
        if (request.policySha256 !== this.profile.policySha256) {
            return { ok: false, error: ConnectorFileFailure.Changed };
        }
        const root: ConnectorFileRootCapability | undefined = this.#roots.capabilities.get(
            request.rootId,
        );
        if (root === undefined) {
            return { ok: false, error: ConnectorFileFailure.Denied };
        }
        const mutation: boolean = ConnectorFilesCodec.isMutation(request.action);
        if (
            mutation &&
            (this.profile.mode !== ConnectorFileMode.ReadWrite ||
                root.staging === null ||
                stagingId === undefined ||
                !/^[a-f0-9]{64}$/u.test(stagingId))
        ) {
            return { ok: false, error: ConnectorFileFailure.Denied };
        }
        if (effect !== undefined && mutation && effect.staging === null) {
            return { ok: false, error: ConnectorFileFailure.Denied };
        }
        const payload: string = JSON.stringify({
            action: request.action,
            requestId: request.requestId,
            path: request.path,
            ...(ConnectorUploadCodec.isRequest(request)
                ? {
                      uploadId: request.uploadId,
                      mode: request.mode,
                      sizeBytes: request.sizeBytes.toString(),
                      sha256: request.sha256,
                      bindingSha256: createHash('sha256')
                          .update(
                              JSON.stringify([
                                  request.policySha256,
                                  request.rootId,
                                  request.path,
                                  request.uploadId,
                                  request.mode,
                                  request.sizeBytes.toString(),
                                  request.sha256,
                              ]),
                          )
                          .digest('hex'),
                      ...(request.action === ConnectorFileAction.UploadChunk
                          ? { offset: request.offset.toString(), dataBase64: request.dataBase64 }
                          : {}),
                  }
                : request.action === ConnectorFileAction.Write
                  ? { mode: request.mode, dataBase64: request.dataBase64, stagingId }
                  : request.action === ConnectorFileAction.Chmod
                    ? { mode: request.mode }
                    : request.action === ConnectorFileAction.Rename
                      ? { destination: request.destination, mode: request.mode }
                      : request.action === ConnectorFileAction.Remove
                        ? { recursive: request.recursive }
                        : request.action === ConnectorFileAction.Read
                          ? { offset: request.offset.toString(), limit: request.limit }
                          : request.action === ConnectorFileAction.List
                            ? { cursor: request.cursor.toString() }
                            : {}),
        });
        const outcome: ConnectorNativeOutcome<ConnectorFileResponse> = await this.#process.run(
            root,
            payload,
            (raw: unknown): ConnectorFileResponse => ConnectorFilesCodec.response(raw, request),
            mutation,
            effect === undefined
                ? undefined
                : { root: effect.root, staging: mutation ? effect.staging : null },
        );
        return outcome.ok
            ? outcome.value
            : {
                  ok: false,
                  error: mutation
                      ? ConnectorFileFailure.Indeterminate
                      : ConnectorFileFailure.Unavailable,
              };
    }
}
