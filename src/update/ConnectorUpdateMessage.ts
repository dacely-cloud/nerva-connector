// SPDX-FileCopyrightText: 2026 Dacely <business@dacely.com>
// SPDX-License-Identifier: LicenseRef-Proprietary

/** Finite IPC messages carry no credentials, paths, arbitrary text or release authority. */
export const ConnectorUpdateStatus = {
    Check: 'check',
    Checking: 'checking',
    Current: 'current',
    Installing: 'installing',
    Failed: 'failed',
} as const;
/** Update state values derive from their runtime catalog. */
export type ConnectorUpdateStatus =
    (typeof ConnectorUpdateStatus)[keyof typeof ConnectorUpdateStatus];
/** The one allowed supervisor IPC envelope. */
export interface ConnectorUpdatePacket {
    readonly nervaConnectorUpdate: ConnectorUpdateStatus;
}

/** Both ends narrow IPC input before acting and project only fixed user-facing messages. */
export class ConnectorUpdateMessage {
    /** Unknown messages and extra properties cannot trigger an update or inject terminal output. */
    public static read(value: unknown): ConnectorUpdateStatus | null {
        if (
            typeof value !== 'object' ||
            value === null ||
            Object.getPrototypeOf(value) !== Object.prototype ||
            Reflect.ownKeys(value).length !== 1
        ) {
            return null;
        }
        const descriptor: PropertyDescriptor | undefined = Object.getOwnPropertyDescriptor(
            value,
            'nervaConnectorUpdate',
        );
        if (
            descriptor === undefined ||
            descriptor.enumerable !== true ||
            !Object.hasOwn(descriptor, 'value')
        ) {
            return null;
        }
        const candidate: unknown = descriptor.value;
        return (
            Object.values(ConnectorUpdateStatus).find(
                (status: ConnectorUpdateStatus): boolean => status === candidate,
            ) ?? null
        );
    }

    /** Public messages explain check results without exposing network or installation details. */
    public static rows(status: ConnectorUpdateStatus): readonly string[] {
        switch (status) {
            case ConnectorUpdateStatus.Checking:
                return ['Checking for updates…'];
            case ConnectorUpdateStatus.Current:
                return ['Nerva Connector is up to date.'];
            case ConnectorUpdateStatus.Installing:
                return ['Installing an update. Nerva Connector will restart automatically.'];
            case ConnectorUpdateStatus.Failed:
                return [
                    "Couldn't update Nerva Connector. Your current version is still available; another check will run automatically.",
                ];
            case ConnectorUpdateStatus.Check:
                return [];
        }
    }
}
