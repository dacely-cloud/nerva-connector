// SPDX-FileCopyrightText: 2026 Dacely <business@dacely.com>
// SPDX-License-Identifier: LicenseRef-Proprietary

import { ConnectorHostShell } from 'nerva-connector-protocol/protocol/ConnectorHostArgumentChoices.js';
/** Full computer operations run with the connector user's existing OS permissions. */
export const HostOperation = {
    NetworkResolve: 'network-resolve',
    HttpOpen: 'http-open',
    HttpRead: 'http-read',
    HttpClose: 'http-close',
    EnvironmentInspect: 'environment-inspect',
    DesktopInfo: 'desktop-info',
    ApplicationOpen: 'application-open',
    DesktopSnapshot: 'desktop-snapshot',
    Screenshot: 'screenshot',
    Pointer: 'pointer',
    Key: 'key',
    Text: 'text',
    Publish: 'publish',
    Rename: 'rename',
    Chmod: 'chmod',
    Digest: 'digest',
    Read: 'read',
    Write: 'write',
    Stat: 'stat',
    List: 'list',
    Mkdir: 'mkdir',
    Remove: 'remove',
    Start: 'start',
    Output: 'output',
    Input: 'input',
    Stop: 'stop',
    Release: 'release',
} as const;

/** Operation names remain available to the local grant owner at runtime. */
export type HostOperation = (typeof HostOperation)[keyof typeof HostOperation];

/** Every operation is checked against the current local and authenticated remote authority. */
export interface HostWorkspaceAccess {
    readonly operation: HostOperation;
    readonly path: string | null;
    readonly destinationPath: string | null;
    readonly processId: string | null;
    /** An HTTP source has its own identity and never impersonates an OS process. */
    readonly transferId?: string;
}

/** The integration supplies verified full-computer authority; pairing alone must never supply this owner. */
export interface HostWorkspaceAuthorization {
    /** Reject revoked, expired, wrong-account or absent local host access before performing the operation. */
    authorize(access: HostWorkspaceAccess): Promise<void>;
}

/** A full-computer runtime owns processes and bounds its own retained data, without claiming OS confinement. */
export interface HostWorkspaceOptions {
    readonly directory: string;
    readonly authorization: HostWorkspaceAuthorization;
    /** A caller-verified compiled Windows job launcher; required on Windows. */
    readonly windowsLauncher?: string;
    /** Explicit local interactive session override; never supplied by an untrusted tool request. */
    readonly desktopEnvironment?: Readonly<Record<string, string>>;
    /** Called once with a started program's or terminal's ID when it ends, is released or the workspace closes. */
    readonly ended?: (processId: string) => void;
}

/** A caller selects an actual command or executable, working directory, environment and finite lifetime. */
export interface HostProcessRequest {
    readonly executable: string | null;
    readonly arguments: readonly string[];
    readonly shell: ConnectorHostShell | null;
    readonly command: string | null;
    readonly directory: string | null;
    readonly environment: Readonly<Record<string, string>>;
    readonly timeoutMs: number;
    /** Opt-in cell expiry follows the whole owned lifetime; unconfirmed shutdown always retains the cell. */
    readonly retentionAfterTimeoutMs?: number;
}

/** Exact output offsets make bounded ring-buffer loss explicit instead of silently dropping bytes. */
export interface HostProcessOutput {
    readonly offset: bigint;
    readonly nextOffset: bigint;
    readonly endOffset: bigint;
    readonly truncated: boolean;
    readonly bytes: Buffer;
}

/** Process failures describe observed lifecycle, never proof that a failed command had no effects. */
export const HostProcessFailure = {
    Launch: 'launch',
    Timeout: 'timeout',
    Cancelled: 'cancelled',
    Signal: 'signal',
} as const;

/** Failure values remain runtime inspectable. */
export type HostProcessFailure = (typeof HostProcessFailure)[keyof typeof HostProcessFailure];

/** An owned process remains addressable after exit until the caller explicitly releases it. */
export interface HostProcessSnapshot {
    readonly processId: string;
    readonly running: boolean;
    /** Windows reports the owned Job Object's activity; POSIX or unavailable evidence remains explicitly unknown. */
    readonly treeRunning: boolean | null;
    /** True only after EOF totals match all locally received stdout and stderr bytes. */
    readonly outputComplete: boolean;
    readonly stdoutFinalBytes: bigint | null;
    readonly stderrFinalBytes: bigint | null;
    readonly exitCode: number | null;
    readonly signal: string | null;
    readonly failure: HostProcessFailure | null;
    readonly stdout: HostProcessOutput;
    readonly stderr: HostProcessOutput;
}

/** A captured regular-file generation uses exact metadata preconditions. */
export interface HostFileSnapshot {
    readonly identity: string;
    readonly size: bigint;
    readonly modifiedAtNs: bigint;
}

/** Complete-file hashes use one explicit runtime algorithm name. */
export const HostFileDigestAlgorithm = { Sha256: 'sha256' } as const;
/** Runtime-accessible file digest algorithm. */
export type HostFileDigestAlgorithm =
    (typeof HostFileDigestAlgorithm)[keyof typeof HostFileDigestAlgorithm];

/** Complete streamed hashes retain the exact generation metadata that was validated. */
export interface HostFileDigestResult extends HostFileSnapshot {
    readonly algorithm: HostFileDigestAlgorithm;
    readonly digest: string;
}

/** Files use exact external quantities; each read is a bounded chunk. */
export interface HostFileRead {
    readonly offset: bigint;
    readonly nextOffset: bigint;
    readonly size: bigint;
    readonly eof: boolean;
    readonly bytes: Buffer;
}

/** Stat reports symlinks explicitly rather than silently asserting a regular file. */
export const HostFileKind = {
    File: 'file',
    Directory: 'directory',
    Symlink: 'symlink',
    Other: 'other',
} as const;

/** Named filesystem kinds are shared by stat and directory entries. */
export type HostFileKind = (typeof HostFileKind)[keyof typeof HostFileKind];

/** Exact file metadata preserves byte sizes and nanosecond timestamps. */
export interface HostFileMetadata {
    /** Exact dev/ino/birthtimeNs/ctimeNs metadata token; not a content hash or immutable-open-file guarantee. */
    readonly identity: string;
    readonly kind: HostFileKind;
    readonly size: bigint;
    readonly modifiedAtNs: bigint;
    readonly mode: number;
}

/** A directory entry is untrusted display data, never an instruction. */
export interface HostDirectoryEntry {
    readonly name: string;
    readonly kind: HostFileKind;
}

/** Directory pagination is bounded; concurrent directory changes may change enumeration order. */
export interface HostDirectoryPage {
    readonly entries: readonly HostDirectoryEntry[];
    readonly nextOffset: number | null;
}

/** Bounds size connector-owned buffers and replies; no count of processes, operations or digests is refused. */
export class HostWorkspaceLimits {
    /** File and process output replies retain at most one MiB. */
    public static readonly chunkBytes: number = 1024 * 1024;
    /** Streaming hashes retain one fixed 256 KiB buffer per admitted digest. */
    public static readonly digestChunkBytes: number = 256 * 1024;
    /** Hashing has a finite runtime budget, without a total file-size truncation rule. */
    public static readonly digestTimeoutMs: number = 30000;
    /** Each stream retains its newest four MiB with exact loss offsets. */
    public static readonly streamBytes: number = 4 * 1024 * 1024;
    /** A blocked stdin write cannot monopolize the command channel beyond ten seconds. */
    public static readonly inputWriteMs: number = 10000;
    /** One invocation has a finite lifetime of at most seven days. */
    public static readonly timeoutMs: number = 7 * 24 * 60 * 60 * 1000;
    /** Explicit timeout retention stays bounded between one second and one day. */
    public static readonly retentionAfterTimeoutMs: number = 24 * 60 * 60 * 1000;
    /** Each directory reply remains bounded. */
    public static readonly directoryEntries: number = 1000;
}
