// SPDX-FileCopyrightText: 2026 Nerva contributors
// SPDX-License-Identifier: LicenseRef-Proprietary

import { Boundary } from 'nerva-connector-protocol/protocol/Boundary.js';
import { ConnectorEnrollmentCodec } from 'nerva-connector-protocol/protocol/ConnectorEnrollmentCodec.js';
import { ConnectorFilesCodec } from 'nerva-connector-protocol/protocol/ConnectorFilesCodec.js';
import {
    ConnectorFileMode,
    type ConnectorFileList,
    type ConnectorFileRead,
    type ConnectorFileStat,
    type ConnectorFileResponse,
} from 'nerva-connector-protocol/protocol/ConnectorFiles.js';
import { ConnectorFileKind } from 'nerva-connector-protocol/protocol/ConnectorFileTypes.js';
import { ConnectorFileAction } from 'nerva-connector-protocol/protocol/ConnectorFileTypes.js';
import type { ConnectorFileRootCapability } from './ConnectorFileRoots.js';
import type {
    ConnectorFilesystemProcess,
    ConnectorNativeOutcome,
} from './ConnectorFilesystemProcess.js';
import { ConnectorFileStageQuiescence } from './ConnectorFileStageQuiescence.js';

/** Only existing read-only native operations observe the privately selected staging descriptor. */
type StageObservation = ConnectorFileList | ConnectorFileRead | ConnectorFileStat;

/** Reuses the original verified helper without replacing a policy pin or introducing a new remote action. */
export class ConnectorFileStageInspector {
    /** Unknown contents are retained; the normal bounded approval marker is the sole non-operation leaf. */
    public static async inspect(
        process: ConnectorFilesystemProcess,
        root: ConnectorFileRootCapability,
        rootPath: string,
        policySha256: string,
        signal: AbortSignal,
    ): Promise<ConnectorFileStageQuiescence> {
        if (signal.aborted) {
            return ConnectorFileStageQuiescence.Unknown;
        }
        if (root.staging === null) {
            return ConnectorFileStageQuiescence.Quiescent;
        }
        const privateRoot: ConnectorFileRootCapability = { directory: root.staging, staging: null };
        const list: ConnectorFileList = {
            action: ConnectorFileAction.List,
            requestId: 'local-stage-preparation',
            policySha256,
            rootId: 'private-stage',
            path: '.',
            cursor: 0n,
        };
        const observed: ConnectorFileResponse | null = await this.#call(process, privateRoot, list);
        if (
            signal.aborted ||
            observed === null ||
            !observed.ok ||
            observed.result.action !== ConnectorFileAction.List
        ) {
            return ConnectorFileStageQuiescence.Unknown;
        }
        const page: typeof observed.result = observed.result;
        if (page.metadata.kind !== ConnectorFileKind.Directory || page.metadata.mode !== 0o700) {
            return ConnectorFileStageQuiescence.Unknown;
        }
        if (page.nextCursor !== null || page.entries.length > 1) {
            return ConnectorFileStageQuiescence.Busy;
        }
        const entry: (typeof page.entries)[number] | undefined = page.entries[0];
        if (entry !== undefined) {
            if (entry.name !== 'approval.json' || entry.kind !== ConnectorFileKind.File) {
                return ConnectorFileStageQuiescence.Busy;
            }
            if (signal.aborted) {
                return ConnectorFileStageQuiescence.Unknown;
            }
            const read: ConnectorFileRead = {
                action: ConnectorFileAction.Read,
                requestId: list.requestId,
                policySha256,
                rootId: list.rootId,
                path: 'approval.json',
                offset: 0n,
                limit: 16384,
            };
            const output: ConnectorFileResponse | null = await this.#call(
                process,
                privateRoot,
                read,
            );
            if (
                signal.aborted ||
                output === null ||
                !output.ok ||
                output.result.action !== ConnectorFileAction.Read
            ) {
                return ConnectorFileStageQuiescence.Unknown;
            }
            const bytes: Buffer = Buffer.from(output.result.dataBase64, 'base64');
            try {
                if (
                    output.result.metadata.mode !== 0o600 ||
                    output.result.metadata.sizeBytes > 16384n ||
                    output.result.metadata.sizeBytes !== BigInt(bytes.length)
                ) {
                    return ConnectorFileStageQuiescence.Busy;
                }
                const raw: unknown = JSON.parse(
                    new TextDecoder('utf-8', { fatal: true }).decode(bytes),
                );
                const marker: Readonly<Record<string, unknown>> = Boundary.record(raw, [
                    'bindingSha256',
                    'path',
                    'mode',
                ]);
                ConnectorEnrollmentCodec.digest(marker['bindingSha256']);
                if (marker['path'] !== rootPath || marker['mode'] !== ConnectorFileMode.ReadWrite) {
                    return ConnectorFileStageQuiescence.Busy;
                }
            } catch {
                return ConnectorFileStageQuiescence.Busy;
            } finally {
                bytes.fill(0);
            }
        }
        if (signal.aborted) {
            return ConnectorFileStageQuiescence.Unknown;
        }
        const stat: ConnectorFileStat = {
            action: ConnectorFileAction.Stat,
            requestId: list.requestId,
            policySha256,
            rootId: list.rootId,
            path: '.',
        };
        const after: ConnectorFileResponse | null = await this.#call(process, privateRoot, stat);
        return !signal.aborted &&
            after !== null &&
            after.ok &&
            after.result.action === ConnectorFileAction.Stat &&
            after.result.metadata.kind === ConnectorFileKind.Directory &&
            after.result.metadata.mode === 0o700 &&
            after.result.metadata.sizeBytes === page.metadata.sizeBytes &&
            after.result.metadata.modifiedAtNs === page.metadata.modifiedAtNs
            ? ConnectorFileStageQuiescence.Quiescent
            : ConnectorFileStageQuiescence.Unknown;
    }

    static async #call(
        process: ConnectorFilesystemProcess,
        root: ConnectorFileRootCapability,
        request: StageObservation,
    ): Promise<ConnectorFileResponse | null> {
        const outcome: ConnectorNativeOutcome<ConnectorFileResponse> = await process.run(
            root,
            JSON.stringify({
                action: request.action,
                requestId: request.requestId,
                path: request.path,
                ...(request.action === ConnectorFileAction.List
                    ? { cursor: request.cursor.toString() }
                    : request.action === ConnectorFileAction.Read
                      ? { offset: request.offset.toString(), limit: request.limit }
                      : {}),
            }),
            (raw: unknown): ConnectorFileResponse => ConnectorFilesCodec.response(raw, request),
        );
        return outcome.ok ? outcome.value : null;
    }
}
