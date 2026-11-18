// SPDX-FileCopyrightText: 2026 Nerva contributors
// SPDX-License-Identifier: LicenseRef-Proprietary

import {
    ConnectorClientConfiguration,
    type ConnectorClientIdentity,
} from '../runtime/ConnectorClientConfiguration.js';
import { ConnectorHostGrant } from '../runtime/ConnectorHostGrant.js';
import { type ConnectorHostLocalGrant } from '../runtime/ConnectorHostGrantTypes.js';
import { ConnectorHostCodec } from 'nerva-connector-protocol/protocol/ConnectorHostCodec.js';

/** Explicit operator entrypoint enables or disables paired full-computer consent without resetting journal history. */
export class ConnectorHostAccessCommand {
    /** Callers must stop the foreground connector/service first; its exclusive storage owner rejects concurrent edits. */
    public static async run(args: readonly string[], signal: AbortSignal): Promise<void> {
        const enable: boolean =
            args.length === 6 &&
            args[3] === '--directory' &&
            args[4] !== undefined &&
            args[5] === '--full-computer-access';
        const disable: boolean = args.length === 4 && args[3] === '--disable';
        if (
            args[0] !== 'host-access' ||
            args[1] !== '--config' ||
            args[2] === undefined ||
            (!enable && !disable)
        ) {
            throw new Error(
                'Use nexa connector host-access --config <runtimeFile> --directory <existing tasks> --full-computer-access, or --config <runtimeFile> --disable',
            );
        }
        const identity: ConnectorClientIdentity = await ConnectorClientConfiguration.load(args[2]);
        using resources: DisposableStack = new DisposableStack();
        resources.use(identity.key);
        const previous: ConnectorHostLocalGrant | null = await ConnectorHostGrant.read(identity);
        const directory: string | undefined = enable ? args[4] : previous?.profile.directory;
        if (directory === undefined) {
            throw new Error('No full-computer grant is configured');
        }
        const grant: ConnectorHostLocalGrant = await ConnectorHostGrant.install(
            identity,
            directory,
            enable,
            signal,
        );
        process.stdout.write(ConnectorHostCodec.encode(grant.profile) + '\n');
    }
}
