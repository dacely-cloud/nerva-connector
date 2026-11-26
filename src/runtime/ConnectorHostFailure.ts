// SPDX-FileCopyrightText: 2026 Dacely <business@dacely.com>
// SPDX-License-Identifier: LicenseRef-Proprietary

import { HostOperationError } from '../host/HostOperationError.js';
import { HostDesktopError } from '../host/HostDesktopError.js';
import {
    ConnectorHostTool,
    ConnectorHostOutcome,
    ConnectorHostErrorCode,
    type ConnectorHostResponse,
} from 'nerva-connector-protocol/protocol/ConnectorHost.js';

/** Public error codes and effect certainty remain separate; native diagnostics never cross the paired relay. */
export class ConnectorHostFailure {
    static readonly #observations: ReadonlySet<ConnectorHostTool> = new Set([
        ConnectorHostTool.ComputerInfo,
        ConnectorHostTool.NetworkResolve,
        ConnectorHostTool.EnvironmentInspect,
        ConnectorHostTool.FileRead,
        ConnectorHostTool.FileDigest,
        ConnectorHostTool.FileStat,
        ConnectorHostTool.DirectoryList,
        ConnectorHostTool.ProcessRead,
        ConnectorHostTool.TerminalRead,
        ConnectorHostTool.DesktopInfo,
        ConnectorHostTool.DesktopSnapshot,
    ]);

    /** Only observations or an operation owner's explicit pre-effect evidence establish definitive failure. */
    public static response(tool: ConnectorHostTool, caught: unknown): ConnectorHostResponse {
        return {
            outcome:
                this.#observations.has(tool) ||
                (caught instanceof HostOperationError && caught.definitive) ||
                (caught instanceof HostDesktopError && caught.definitive)
                    ? ConnectorHostOutcome.Failed
                    : ConnectorHostOutcome.Indeterminate,
            resultJson: null,
            errorCode: this.#code(caught),
        };
    }

    static #code(caught: unknown): ConnectorHostErrorCode {
        if (caught instanceof HostOperationError) {
            return caught.code;
        }
        if (!(caught instanceof Error)) {
            return ConnectorHostErrorCode.OperationFailed;
        }
        if (caught.name === 'AbortError' || caught.name === 'TimeoutError') {
            return ConnectorHostErrorCode.Canceled;
        }
        const code: unknown = Reflect.get(caught, 'code');
        switch (code) {
            case 'ENOENT':
                return ConnectorHostErrorCode.NotFound;
            case 'EEXIST':
                return ConnectorHostErrorCode.AlreadyExists;
            case 'ENOTDIR':
                return ConnectorHostErrorCode.NotDirectory;
            case 'EISDIR':
                return ConnectorHostErrorCode.IsDirectory;
            case 'EACCES':
            case 'EPERM':
                return ConnectorHostErrorCode.PermissionDenied;
            case 'ENOTSUP':
            case 'EOPNOTSUPP':
            case 'ENOSYS':
            case 'ENOEXEC':
                return ConnectorHostErrorCode.Unsupported;
            case 'EINVAL':
            case 'ERR_INVALID_ARG_TYPE':
            case 'ERR_OUT_OF_RANGE':
                return ConnectorHostErrorCode.InvalidRequest;
            case 'E2BIG':
            case 'EFBIG':
            case 'EMFILE':
            case 'ENFILE':
            case 'ENOSPC':
                return ConnectorHostErrorCode.ResourceLimit;
            case 'EXDEV':
                return ConnectorHostErrorCode.CrossDevice;
            default:
                return ConnectorHostErrorCode.OperationFailed;
        }
    }
}
