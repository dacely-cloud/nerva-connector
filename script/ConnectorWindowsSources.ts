// SPDX-FileCopyrightText: 2026 Nerva contributors
// SPDX-License-Identifier: LicenseRef-Proprietary

import { resolve } from 'node:path';

/** Complete source groups shared by Windows builds and native behavior tests. */
export class ConnectorWindowsSources {
    /** State ownership, strict requests, pinned filesystem operations and artifact transfer. */
    public static readonly state: readonly string[] = [
        'StateOwner.cs',
        'StateFiles.cs',
        'StatePath.cs',
        'StateSecurity.cs',
        'StateDirectory.cs',
        'StateProtocol.cs',
        'StateNative.cs',
        'GpuInventory.cs',
        'ArtifactOperations.cs',
        'ArtifactStream.cs',
    ].map((name: string): string => resolve('native/windows', name));

    /** Trusted bootstrap process creation and its native ABI. */
    public static readonly bootstrapProcess: readonly string[] = [
        'BootstrapProcess.cs',
        'BootstrapProcessNative.cs',
    ].map((name: string): string => resolve('native/windows', name));

    /** Complete release bootstrap, including the original state owner. */
    public static readonly bootstrap: readonly string[] = [
        ...this.state,
        ...this.bootstrapProcess,
        ...[
            'ReleaseBootstrap.cs',
            'BootstrapConfig.cs',
            'BootstrapStaging.cs',
            'BootstrapInstallation.cs',
            'BootstrapNative.cs',
        ].map((name: string): string => resolve('native/windows', name)),
    ];

    /** Host job lifecycle and native process ownership operations. */
    public static readonly hostJob: readonly string[] = ['HostJob.cs', 'HostJobNative.cs'].map(
        (name: string): string => resolve('native/windows', name),
    );

    /** Authenticated host process broker and its owned control/output streams. */
    public static readonly hostProcess: readonly string[] = [
        'HostProcess.cs',
        'HostProcessStreams.cs',
        'HostLaunch.cs',
    ].map((name: string): string => resolve('native/windows', name));

    /** Interactive desktop operations and their native input layouts. */
    public static readonly desktop: readonly string[] = [
        'HostDesktop.cs',
        'HostDesktopNative.cs',
        'HostApplication.cs',
        'HostDesktopFrame.cs',
    ].map((name: string): string => resolve('native/windows', name));

    /** Bounded terminal protocol, console lifecycle and synchronous I/O pump. */
    public static readonly terminal: readonly string[] = [
        'HostTerminal.cs',
        'HostTerminalConsole.cs',
        'HostTerminalPump.cs',
        'HostTerminalProtocol.cs',
    ].map((name: string): string => resolve('native/windows', name));

    /** Complete host executable; desktop, process and terminal commands share one entry point. */
    public static readonly host: readonly string[] = [
        ...this.hostProcess,
        ...this.desktop,
        ...this.hostJob,
        ...this.terminal,
    ];

    /** Setup and uninstall share one implementation and explicit installation choices. */
    public static readonly setup: readonly string[] = [
        'Setup.cs',
        'SetupChoices.cs',
        'SetupLayout.cs',
        'SetupDirectory.cs',
        'SetupForm.cs',
        'Shortcut.cs',
        'InstallerPayload.cs',
        'Startup.cs',
    ].map((name: string): string => resolve('native/windows/installer', name));

    /** The installed supervisor, its UI/process ownership, update reader and native calls. */
    public static readonly supervisor: readonly string[] = [
        'Supervisor.cs',
        'SupervisorProgram.cs',
        'SupervisorProcess.cs',
        'SupervisorUpdates.cs',
        'SupervisorLog.cs',
        'SupervisorNative.cs',
        'Startup.cs',
        'UpdateFeed.cs',
    ].map((name: string): string => resolve('native/windows/installer', name));
}
