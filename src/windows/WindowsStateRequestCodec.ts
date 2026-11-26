// SPDX-FileCopyrightText: 2026 Dacely <business@dacely.com>
// SPDX-License-Identifier: LicenseRef-Proprietary

import {
    WindowsStateOperation,
    WindowsStateFailure,
    WindowsStateError,
    type WindowsStateParameters,
    type WindowsStateRequest,
} from './WindowsStateProtocol.js';
import { ProtectedFileLimits } from '../local/ProtectedFileLimits.js';

/** A fixed primitive envelope keeps artifact streaming separate from bounded private-state bytes. */
export class WindowsStateRequestCodec {
    /** Artifact files permit a larger finite disk stream without expanding private byte-response limits. */
    public static create(
        id: string,
        operation: WindowsStateOperation,
        parameters: WindowsStateParameters,
    ): WindowsStateRequest {
        if (!/^[1-9][0-9]{0,19}$/u.test(id)) {
            throw new WindowsStateError(WindowsStateFailure.Invalid);
        }
        const artifact: boolean =
            operation === WindowsStateOperation.ArtifactDescribe ||
            operation === WindowsStateOperation.ArtifactVerify ||
            operation === WindowsStateOperation.ArtifactInstall;
        const maximum: number | undefined = parameters.maximumBytes;
        const leafOperations: readonly WindowsStateOperation[] = [
            WindowsStateOperation.Read,
            WindowsStateOperation.Write,
            WindowsStateOperation.Remove,
            WindowsStateOperation.CleanPartial,
        ];
        const leaf: boolean = leafOperations.includes(operation);
        const stateMaximum: number =
            leaf && parameters.name !== undefined
                ? ProtectedFileLimits.maximum(parameters.name)
                : ProtectedFileLimits.ordinaryBytes;
        if (
            (artifact && maximum === undefined) ||
            (maximum !== undefined &&
                (!Number.isSafeInteger(maximum) ||
                    maximum < 1 ||
                    maximum > (artifact ? 268435456 : stateMaximum)))
        ) {
            throw new WindowsStateError(WindowsStateFailure.Limit);
        }
        if (artifact && operation !== WindowsStateOperation.ArtifactDescribe) {
            if (
                typeof parameters.sizeBytes !== 'bigint' ||
                parameters.sizeBytes < 1n ||
                maximum === undefined ||
                parameters.sizeBytes > BigInt(maximum) ||
                typeof parameters.sha256 !== 'string' ||
                !/^[a-f0-9]{64}$/u.test(parameters.sha256)
            ) {
                throw new WindowsStateError(WindowsStateFailure.Invalid);
            }
        } else if (parameters.sizeBytes !== undefined || parameters.sha256 !== undefined) {
            throw new WindowsStateError(WindowsStateFailure.Invalid);
        }
        if (
            operation === WindowsStateOperation.ArtifactInstall
                ? typeof parameters.replace !== 'boolean'
                : parameters.replace !== undefined
        ) {
            throw new WindowsStateError(WindowsStateFailure.Invalid);
        }
        return {
            id,
            operation,
            path: parameters.path ?? null,
            purpose: parameters.purpose ?? null,
            lease: parameters.lease ?? null,
            name: parameters.name ?? null,
            maximumBytes: maximum ?? null,
            dataBase64: parameters.dataBase64 ?? null,
            initialize: parameters.initialize ?? null,
            secret: parameters.secret ?? null,
            sizeBytes: parameters.sizeBytes?.toString() ?? null,
            sha256: parameters.sha256 ?? null,
            replace: parameters.replace ?? null,
        };
    }
}
