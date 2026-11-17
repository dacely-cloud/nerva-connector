// SPDX-FileCopyrightText: 2026 Nerva contributors
// SPDX-License-Identifier: LicenseRef-Proprietary

/** The local native state owner exposes no command execution, arbitrary forwarding or remote authority. */
export const WindowsStateOperation = {
    GpuInventory: 'gpu-inventory',
    Root: 'root',
    Directory: 'directory',
    Open: 'open',
    Close: 'close',
    Exists: 'exists',
    Read: 'read',
    Write: 'write',
    Remove: 'remove',
    CleanPartial: 'clean-partial',
    List: 'list',
    ReadPath: 'read-path',
    ExistsPath: 'exists-path',
    ArtifactDescribe: 'artifact-describe',
    ArtifactVerify: 'artifact-verify',
    ArtifactInstall: 'artifact-install',
} as const;

/** Fixed native operation names are shared by runtime validation and callers. */
export type WindowsStateOperation =
    (typeof WindowsStateOperation)[keyof typeof WindowsStateOperation];

/** Pairing and identity ownership do not imply Windows file or program capabilities. */
export const WindowsStatePurpose = {
    Installation: 'installation',
    Runtime: 'runtime',
    Identity: 'identity',
    Pairing: 'pairing',
} as const;

/** A native lease has one explicitly selected state ownership purpose. */
export type WindowsStatePurpose = (typeof WindowsStatePurpose)[keyof typeof WindowsStatePurpose];

/** Only finite non-sensitive native failure codes may cross the process boundary. */
export const WindowsStateFailure = {
    Invalid: 'invalid',
    Untrusted: 'untrusted',
    Missing: 'not-found',
    Exists: 'exists',
    Busy: 'busy',
    Limit: 'limit',
    Io: 'io',
    Unavailable: 'unavailable',
    Unsupported: 'unsupported',
    Migration: 'migration-required',
    HelperMissing: 'helper-missing',
    HelperUntrusted: 'helper-untrusted',
} as const;

/** Only these safe failure categories may leave the native owner. */
export type WindowsStateFailure = (typeof WindowsStateFailure)[keyof typeof WindowsStateFailure];

/** Named optional arguments become an exact fixed-field native envelope before serialization. */
export interface WindowsStateParameters {
    readonly path?: string;
    readonly purpose?: WindowsStatePurpose;
    readonly lease?: string;
    readonly name?: string;
    readonly maximumBytes?: number;
    readonly dataBase64?: string;
    readonly initialize?: boolean;
    readonly secret?: boolean;
    readonly sizeBytes?: bigint;
    readonly sha256?: string;
    readonly replace?: boolean;
}

/** Request IDs are decimal strings; secret bytes never enter argv, logs or diagnostics. */
export interface WindowsStateRequest {
    readonly id: string;
    readonly operation: WindowsStateOperation;
    readonly path: string | null;
    readonly purpose: WindowsStatePurpose | null;
    readonly lease: string | null;
    readonly name: string | null;
    readonly maximumBytes: number | null;
    readonly dataBase64: string | null;
    readonly initialize: boolean | null;
    readonly secret: boolean | null;
    readonly sizeBytes: string | null;
    readonly sha256: string | null;
    readonly replace: boolean | null;
}

/** Response fields are validated before any path, opaque lease or private bytes enter application code. */
export interface WindowsStateResponse {
    readonly id: string;
    readonly ok: boolean;
    readonly path: string | null;
    readonly lease: string | null;
    readonly exists: boolean | null;
    readonly names: readonly string[] | null;
    readonly dataBase64: string | null;
    readonly error: WindowsStateFailure | null;
    readonly sizeBytes: bigint | null;
    readonly sha256: string | null;
}

/** Error codes retain explicit missing-file handling without pretending Windows has POSIX ownership. */
export class WindowsStateError extends Error {
    /** Only the platform adapter translates safe categories; no raw native diagnostics are retained. */
    public readonly code: string;

    /** The UI can explain actual permission or competing-owner failures without disclosing physical paths. */
    public constructor(public readonly failure: WindowsStateFailure) {
        super(
            failure === WindowsStateFailure.Untrusted
                ? 'Windows connector storage permissions could not be verified. Existing keys were preserved.'
                : failure === WindowsStateFailure.Busy
                  ? 'This connector is already open in another process.'
                  : failure === WindowsStateFailure.Migration
                    ? 'An existing connector identity requires an explicit migration. Its keys and history were preserved.'
                    : failure === WindowsStateFailure.HelperMissing
                      ? 'The compiled Windows helper is missing. Restore the verified Windows connector release before starting it.'
                      : failure === WindowsStateFailure.HelperUntrusted
                        ? 'The Windows helper does not match this connector release. Restore the verified Windows connector release before starting it.'
                        : failure === WindowsStateFailure.Unavailable
                          ? 'The compiled Windows helper could not start. .NET Framework 4.x is required.'
                          : failure === WindowsStateFailure.Unsupported
                            ? 'This Windows version or filesystem lacks a required secure file operation. Existing connector files were preserved.'
                            : 'Secure Windows connector storage could not complete (' +
                              failure +
                              ').',
        );
        this.name = 'WindowsStateError';
        this.code =
            failure === WindowsStateFailure.Missing
                ? 'ENOENT'
                : failure === WindowsStateFailure.Exists
                  ? 'EEXIST'
                  : failure === WindowsStateFailure.Busy
                    ? 'EBUSY'
                    : failure === WindowsStateFailure.Untrusted
                      ? 'EACCES'
                      : failure === WindowsStateFailure.Invalid
                        ? 'EINVAL'
                        : failure === WindowsStateFailure.Unsupported
                          ? 'ENOTSUP'
                          : failure === WindowsStateFailure.Limit
                            ? 'EFBIG'
                            : 'EIO';
    }
}
