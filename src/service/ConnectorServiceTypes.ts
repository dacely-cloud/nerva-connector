// SPDX-FileCopyrightText: 2026 Dacely <business@dacely.com>
// SPDX-License-Identifier: LicenseRef-Proprietary

/** System units require an explicit root invocation; user units retain the invoking account. */
export enum ConnectorServiceScope {
    System = 'system',
    User = 'user',
}
/** Every administrative operation is local and targets one derived installation unit. */
export enum ConnectorServiceAction {
    Install = 'install',
    Start = 'start',
    Status = 'status',
    Stop = 'stop',
    Remove = 'remove',
    Connect = 'connect',
}
/** The driver exposes no arbitrary systemctl subcommand or argument list. */
export enum ConnectorServiceOperation {
    Reload = 'daemon-reload',
    Enable = 'enable',
    Disable = 'disable',
    Start = 'start',
    Stop = 'stop',
}
/** Durable intent survives a lost systemd reply without creating another service or identity. */
export enum ConnectorServicePhase {
    Installing = 'installing',
    Installed = 'installed',
    Removing = 'removing',
}
/** A manager observation is not device authentication or cloud online presence. */
export enum ConnectorServiceActiveState {
    Active = 'active',
    Reloading = 'reloading',
    Inactive = 'inactive',
    Failed = 'failed',
    Activating = 'activating',
    Deactivating = 'deactivating',
    Refreshing = 'refreshing',
}
/** Only current locally owned unit-file states are admitted. */
export enum ConnectorServiceEnabledState {
    Enabled = 'enabled',
    EnabledRuntime = 'enabled-runtime',
    Disabled = 'disabled',
    Static = 'static',
    Masked = 'masked',
    MaskedRuntime = 'masked-runtime',
    Linked = 'linked',
    LinkedRuntime = 'linked-runtime',
    Indirect = 'indirect',
    Alias = 'alias',
    Generated = 'generated',
    Transient = 'transient',
    Bad = 'bad',
    Absent = '',
}
/** Unit existence is observed from the selected manager, never inferred from browser state. */
export enum ConnectorServiceLoadState {
    Loaded = 'loaded',
    NotFound = 'not-found',
    Masked = 'masked',
    Error = 'error',
    BadSetting = 'bad-setting',
    Stub = 'stub',
    Merged = 'merged',
}
/** No unit name, command, executable or scope comes from a remote caller. */
export interface ConnectorServiceLayout {
    readonly scope: ConnectorServiceScope;
    readonly installationDirectory: string;
    readonly unitDirectory: string;
    readonly unitName: string;
    readonly unitFile: string;
    readonly source: string;
    readonly sha256: string;
}
/** Small private local receipt binds one installation to exactly one managed unit. */
export interface ConnectorServiceRecord {
    readonly scope: ConnectorServiceScope;
    readonly unitName: string;
    readonly sha256: string;
    readonly phase: ConnectorServicePhase;
}
/** Bounded manager facts preserve exact restart counters and expose no output, credentials or file data. */
export interface ConnectorServiceStatus {
    readonly scope: ConnectorServiceScope;
    readonly unitName: string;
    readonly load: ConnectorServiceLoadState;
    readonly active: ConnectorServiceActiveState;
    readonly enabled: ConnectorServiceEnabledState;
    readonly mainPid: number | null;
    readonly restarts: string | null;
    readonly fragmentPath: string;
    readonly dropInPaths: string;
    readonly needsReload: boolean;
}
/** Backend abstraction preserves the exact unit identity across uncertain command completion and tests. */
export interface ConnectorServiceDriver {
    verify(layout: ConnectorServiceLayout, signal: AbortSignal): Promise<void>;
    command(
        action: ConnectorServiceOperation,
        layout: ConnectorServiceLayout,
        signal: AbortSignal,
    ): Promise<void>;
    status(layout: ConnectorServiceLayout, signal: AbortSignal): Promise<ConnectorServiceStatus>;
}
