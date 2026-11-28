// SPDX-FileCopyrightText: 2026 Dacely <business@dacely.com>
// SPDX-License-Identifier: LicenseRef-Proprietary

import { ConnectorHostErrorCode } from 'nerva-connector-protocol/protocol/ConnectorHost.js';

/** A bounded native error can prove rejection before an operation had effects. */
export class HostOperationError extends Error {
    /** Use fixed diagnostic prose without command arguments or paths. The paired relay receives only the code and effect classification. */
    public constructor(
        public readonly code: ConnectorHostErrorCode,
        message: string,
        public readonly definitive: boolean,
        options?: ErrorOptions,
    ) {
        super(message, options);
        this.name = 'HostOperationError';
    }

    /**
     * Classifies an error raised before the operation could have had any effect as a definitive failure.
     *
     * @remarks
     * Call this only where the connector itself established that nothing was attempted yet, such as validation or
     * a native lookup that failed before the effectful call. The public code follows the cause, which stays attached
     * for the local log and never crosses the paired relay.
     *
     * @param cause - What was thrown before the effect
     * @param message - Fixed prose naming the refused step, without paths or command data
     * @returns The cause itself when it is already definitive, otherwise a definitive error carrying it
     */
    public static before(cause: unknown, message: string): HostOperationError {
        if (cause instanceof HostOperationError && cause.definitive) {
            return cause;
        }
        return new HostOperationError(HostOperationError.code(cause), message, true, { cause });
    }

    /**
     * The public code a thrown value names.
     *
     * @param caught - What was thrown
     * @returns A host operation error's own code, `canceled` for an abort or timeout, the code an errno or Node error code names, and `operation-failed` for anything else
     */
    public static code(caught: unknown): ConnectorHostErrorCode {
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
            case 'ERR_FS_EISDIR':
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
