// SPDX-FileCopyrightText: 2026 Nerva contributors
// SPDX-License-Identifier: LicenseRef-Proprietary

import type { ConnectorHostPlatform } from 'nerva-connector-protocol/protocol/ConnectorHost.js';

/** A read-only availability question names bare programs and environment variables only. */
export interface HostEnvironmentRequest {
    /** Bare program names searched on the connector runtime PATH, never paths or the current directory. */
    readonly programs: readonly string[];
    /** Environment variable names whose presence, not value, is reported. */
    readonly variables: readonly string[];
}

/** Presence answers align with request order and never disclose resolved paths or variable values. */
export interface HostEnvironmentReport {
    readonly platform: ConnectorHostPlatform;
    readonly programs: readonly boolean[];
    readonly variables: readonly boolean[];
}

/**
 * The environment whose PATH and variables are inspected.
 *
 * @remarks
 * The runtime source is the connector's own `process.env`, which process_start inherits by default.
 * On Windows that object compares names case-insensitively; injected sources must preserve the
 * semantics of the platform they claim.
 */
export interface HostEnvironmentSource {
    /** Selects PATH delimiter, PATHEXT and candidate rules; filesystem paths still use the real OS. */
    readonly platform: ConnectorHostPlatform;
    /** Returns the current value of one variable, or undefined when it is not set. */
    variable(name: string): string | undefined;
}

/** Inspection bounds cover both untrusted request size and locally configured search breadth. */
export class HostEnvironmentLimits {
    /** Each request names at most 256 programs and 256 variables. */
    public static readonly names: number = 256;
    /** Each program or variable name has 1 to 255 Unicode code points. */
    public static readonly nameLength: number = 255;
    /** Only the first 1024 PATH entries are considered. */
    public static readonly pathEntries: number = 1024;
    /** Only the first 32 usable PATHEXT extensions are considered. */
    public static readonly extensions: number = 32;
    /** At most four filesystem probes are outstanding, matching libuv's default worker pool. */
    public static readonly probes: number = 4;
}
