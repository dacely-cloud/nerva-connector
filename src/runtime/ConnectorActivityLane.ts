// SPDX-FileCopyrightText: 2026 Nerva contributors
// SPDX-License-Identifier: LicenseRef-Proprietary

import {
    ConnectorFileAction,
    ConnectorWriteMode,
} from 'nerva-connector-protocol/protocol/ConnectorFileTypes.js';
import type { ConnectorFileOperation } from 'nerva-connector-protocol/protocol/ConnectorFileJobs.js';
import type { ExecutionRequest } from 'nerva-connector-protocol/execution/ExecutionJobs.js';
import type { ConnectorOperationDispatch } from 'nerva-connector-protocol/protocol/ConnectorOperationDispatch.js';
import type { ConnectorActivitySource } from './ConnectorActivity.js';

/** Operation names the folder-access and command lanes report; the dot keeps them apart from every host tool name. */
export const ConnectorActivityLaneOperation = {
    FolderRead: 'folder.read',
    FolderStat: 'folder.stat',
    FolderList: 'folder.list',
    FolderWrite: 'folder.write',
    FolderRemove: 'folder.remove',
    FolderCreate: 'folder.mkdir',
    FolderChmod: 'folder.chmod',
    FolderRename: 'folder.rename',
    UploadBegin: 'folder.upload-begin',
    UploadChunk: 'folder.upload-chunk',
    UploadStatus: 'folder.upload-status',
    UploadCommit: 'folder.upload-commit',
    UploadAbort: 'folder.upload-abort',
    CommandRun: 'command.run',
    CommandStop: 'command.stop',
} as const;
/** Lane operation names derive from their runtime mapping. */
export type ConnectorActivityLaneOperation =
    (typeof ConnectorActivityLaneOperation)[keyof typeof ConnectorActivityLaneOperation];

/**
 * Builds what a local lane reports to the activity screen.
 *
 * @remarks
 * Lane requests are typed objects rather than host JSON, so each source carries a small JSON projection of the
 * fields the screen describes: root aliases, relative paths, flags, program aliases and arguments. Written file
 * bytes and upload chunks never enter the projection, and building it costs no more than the request's names.
 */
export class ConnectorActivityLane {
    /** Most arguments a command projection carries; the screen shows at most 2000 characters of them. */
    public static readonly commandArguments: number = 64;
    static readonly #folder: Readonly<
        Record<ConnectorFileOperation['action'], ConnectorActivityLaneOperation>
    > = {
        [ConnectorFileAction.Read]: ConnectorActivityLaneOperation.FolderRead,
        [ConnectorFileAction.Stat]: ConnectorActivityLaneOperation.FolderStat,
        [ConnectorFileAction.List]: ConnectorActivityLaneOperation.FolderList,
        [ConnectorFileAction.Write]: ConnectorActivityLaneOperation.FolderWrite,
        [ConnectorFileAction.Remove]: ConnectorActivityLaneOperation.FolderRemove,
        [ConnectorFileAction.Mkdir]: ConnectorActivityLaneOperation.FolderCreate,
        [ConnectorFileAction.Chmod]: ConnectorActivityLaneOperation.FolderChmod,
        [ConnectorFileAction.Rename]: ConnectorActivityLaneOperation.FolderRename,
        [ConnectorFileAction.UploadBegin]: ConnectorActivityLaneOperation.UploadBegin,
        [ConnectorFileAction.UploadChunk]: ConnectorActivityLaneOperation.UploadChunk,
        [ConnectorFileAction.UploadStatus]: ConnectorActivityLaneOperation.UploadStatus,
        [ConnectorFileAction.UploadCommit]: ConnectorActivityLaneOperation.UploadCommit,
        [ConnectorFileAction.UploadAbort]: ConnectorActivityLaneOperation.UploadAbort,
    };

    /**
     * Describes one folder-access request.
     *
     * @param jobId - The account job that sent the request
     * @param request - The verified original file operation
     */
    public static folder(jobId: string, request: ConnectorFileOperation): ConnectorActivitySource {
        return {
            jobId,
            toolName: ConnectorActivityLane.#folder[request.action],
            argumentsJson: JSON.stringify({
                rootId: request.rootId,
                path: request.path,
                destination:
                    request.action === ConnectorFileAction.Rename ? request.destination : '',
                recursive: request.action === ConnectorFileAction.Remove && request.recursive,
                create:
                    request.action === ConnectorFileAction.Write &&
                    request.mode === ConnectorWriteMode.Create,
            }),
        };
    }

    /**
     * Describes a command the command lane is about to run.
     *
     * @param dispatch - The verified original start
     */
    public static command(
        dispatch: ConnectorOperationDispatch<ExecutionRequest>,
    ): ConnectorActivitySource {
        return ConnectorActivityLane.#command(dispatch, ConnectorActivityLaneOperation.CommandRun);
    }

    /**
     * Describes a verified stop of the command that is running.
     *
     * @param dispatch - The verified stop naming the running original
     */
    public static commandStop(
        dispatch: ConnectorOperationDispatch<ExecutionRequest>,
    ): ConnectorActivitySource {
        return ConnectorActivityLane.#command(dispatch, ConnectorActivityLaneOperation.CommandStop);
    }

    static #command(
        dispatch: ConnectorOperationDispatch<ExecutionRequest>,
        operation: ConnectorActivityLaneOperation,
    ): ConnectorActivitySource {
        return {
            jobId: dispatch.jobId,
            toolName: operation,
            argumentsJson: JSON.stringify({
                programId: dispatch.request.programId,
                arguments: dispatch.request.arguments.slice(
                    0,
                    ConnectorActivityLane.commandArguments,
                ),
            }),
        };
    }
}
