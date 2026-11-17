// SPDX-FileCopyrightText: 2026 Nerva contributors
// SPDX-License-Identifier: LicenseRef-Proprietary

import { ConnectorUpdateChannel } from '../../src/cli/ConnectorUpdateChannel.js';

/** A fixed probe contains only the console's sanitized public update rows. */
interface ConnectorUpdateProbe {
    readonly rows: readonly string[];
}

const completed: PromiseWithResolvers<undefined> = Promise.withResolvers<undefined>();
const deadline: NodeJS.Timeout = setTimeout((): void => {
    process.exitCode = 1;
    process.disconnect?.();
    completed.resolve(undefined);
}, 5000);
using channel: ConnectorUpdateChannel = new ConnectorUpdateChannel(
    (rows: readonly string[]): void => {
        if (rows.includes('Nerva Connector is up to date.')) {
            const probe: ConnectorUpdateProbe = { rows };
            process.send?.(probe, (): void => process.disconnect?.());
        }
    },
    (): void => {
        clearTimeout(deadline);
        process.stdout.write('channel-closed\n');
        completed.resolve(undefined);
    },
);
await channel.check(new AbortController().signal);
await completed.promise;
