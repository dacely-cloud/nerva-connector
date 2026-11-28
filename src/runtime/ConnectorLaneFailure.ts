// SPDX-FileCopyrightText: 2026 Dacely <business@dacely.com>
// SPDX-License-Identifier: LicenseRef-Proprietary

/** The local capability owners that can retire themselves while the connector runs. */
export const ConnectorLane = {
    /** Full-computer access. */
    Host: 'host',
    /** Approved file access. */
    Files: 'files',
    /** Approved program runs. */
    Execution: 'execution',
    /** Joint workspace publication. */
    Workspaces: 'workspaces',
} as const;

/** Allowed values derive from the runtime mapping. */
export type ConnectorLane = (typeof ConnectorLane)[keyof typeof ConnectorLane];

/**
 * One or more local capability owners retired after a storage, durability or approval check failed.
 *
 * @remarks
 * A retired owner admits no further work, so the running connector ends. Its saved state is still the recovery
 * source: loading the connector again rereads each journal, records any operation that was started but has no
 * result as interrupted, and rechecks the saved approval, exactly as after a process restart. Nothing is started a
 * second time. A condition that persists then fails that load with its own explanation instead.
 */
export class ConnectorLaneFailure extends Error {
    /**
     * @param lanes - The owners that retired, in a fixed order; never empty
     */
    public constructor(public readonly lanes: readonly ConnectorLane[]) {
        super(
            'Connector ' +
                lanes.join(', ') +
                ' access stopped after a local storage or approval check failed',
        );
        this.name = 'ConnectorLaneFailure';
    }
}
