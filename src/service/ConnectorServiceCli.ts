// SPDX-FileCopyrightText: 2026 Dacely <business@dacely.com>
// SPDX-License-Identifier: LicenseRef-Proprietary

import { ConnectorPairClient, type ConnectorPairEvent } from '../runtime/ConnectorPairClient.js';
import { ConnectorClient } from '../runtime/ConnectorClient.js';
import type { ConnectorClientState } from '../runtime/ConnectorClientState.js';
import {
    ConnectorInstallation,
    type ConnectorInstallationView,
} from '../install/ConnectorInstallation.js';
import {
    ConnectorServiceScope,
    ConnectorServiceAction,
    type ConnectorServiceStatus,
} from './ConnectorServiceTypes.js';
import { ConnectorServiceManager } from './ConnectorServiceManager.js';
import { ConnectorServiceUnit } from './ConnectorServiceUnit.js';
import { ConnectorNativeBoot } from '../native/ConnectorNativeBoot.js';
import { ConnectorNativeInstallation } from '../native/ConnectorNativeInstallation.js';
import { ConnectorConnectionLog } from '../runtime/ConnectorConnectionLog.js';

/** Local CLI control has no account credentials, remote RPC or caller-selected systemd command. */
export class ConnectorServiceCli {
    /** One explicit setup owner pairs and enables a service; other actions never initiate pairing. */
    public static async command(
        args: readonly string[],
        signal: AbortSignal,
        observe: (event: ConnectorPairEvent) => void,
    ): Promise<ConnectorServiceStatus> {
        if (
            (args.length !== 5 && args.length !== 7) ||
            args[1] !== '--scope' ||
            args[3] !== '--directory' ||
            args[4] === undefined
        ) {
            throw new Error('Use service ACTION --scope system|user --directory PATH');
        }
        const action: ConnectorServiceAction | undefined = Object.values(
            ConnectorServiceAction,
        ).find((entry): boolean => entry.valueOf() === args[0]);
        const scope: ConnectorServiceScope = this.scope(args[2]);
        if (
            args.length === 7 &&
            (action !== ConnectorServiceAction.Connect ||
                scope !== ConnectorServiceScope.System ||
                args[5] !== '--native-config' ||
                args[6] === undefined)
        ) {
            throw new Error('Native setup is an explicit system-service connect option');
        }
        const manager: ConnectorServiceManager = new ConnectorServiceManager(
            ConnectorServiceUnit.layout(args[4], scope),
        );
        switch (action) {
            case ConnectorServiceAction.Connect: {
                const installed: ConnectorInstallationView = await ConnectorInstallation.read(
                    args[4],
                    signal,
                );
                await ConnectorPairClient.run(installed.pairingFile, signal, observe);
                signal.throwIfAborted();
                if (args[6] !== undefined) {
                    return (await ConnectorNativeInstallation.install(args[6], signal, args[4]))
                        .service;
                }
                await manager.install(signal);
                return await manager.start(signal);
            }
            case ConnectorServiceAction.Install:
                return await manager.install(signal);
            case ConnectorServiceAction.Start:
                return await manager.start(signal);
            case ConnectorServiceAction.Status:
                return await manager.status(signal);
            case ConnectorServiceAction.Stop:
                return await manager.stop(signal);
            case ConnectorServiceAction.Remove:
                return await manager.remove(signal);
            default:
                throw new Error('Unknown connector service operation');
        }
    }
    /** The unit owns one verified enrolled runtime; signal handling remains in the same installed Node process. */
    public static async run(
        directory: string,
        scope: ConnectorServiceScope,
        signal: AbortSignal,
        observe: (state: ConnectorClientState) => void,
    ): Promise<void> {
        const manager: ConnectorServiceManager = new ConnectorServiceManager(
            ConnectorServiceUnit.layout(directory, scope),
        );
        const installed: ConnectorInstallationView = await manager.prepareRuntime(signal);
        await ConnectorNativeBoot.restore(installed, scope, signal);
        const log: ConnectorConnectionLog = new ConnectorConnectionLog(
            ConnectorConnectionLog.location(),
        );
        try {
            await using client: ConnectorClient = await ConnectorClient.load(
                installed.runtimeFile,
                observe,
                undefined,
                signal,
                null,
                log,
            );
            await client.run(signal);
        } finally {
            await log.flush();
        }
    }
    /** Unknown or incomplete scope is rejected rather than promoted to system scope. */
    public static scope(raw: string | undefined): ConnectorServiceScope {
        const scope: ConnectorServiceScope | undefined = Object.values(ConnectorServiceScope).find(
            (entry): boolean => entry.valueOf() === raw,
        );
        if (scope === undefined) {
            throw new Error('Explicit connector service scope required');
        }
        return scope;
    }
}
