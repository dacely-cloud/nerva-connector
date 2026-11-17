// SPDX-FileCopyrightText: 2026 Nerva contributors
// SPDX-License-Identifier: LicenseRef-Proprietary

import {
    ConnectorFileGrant,
    type ConnectorFileGrantContext,
    type ConnectorFileApproval,
} from '../../src/permissions/ConnectorFileGrant.js';

/** The real CLI entry and structured TUI owner run unchanged; only the post-approval preparation boundary is held for cancellation. */
ConnectorFileGrant.approve = async (
    _context: ConnectorFileGrantContext,
    _approval: ConnectorFileApproval,
    signal: AbortSignal,
): Promise<void> => {
    const stopped: PromiseWithResolvers<undefined> = Promise.withResolvers<undefined>();
    const abort: () => void = (): void => stopped.resolve(undefined);
    const timer: NodeJS.Timeout = setTimeout(
        (): void =>
            stopped.reject(new Error('Local prompt cancellation did not reach preparation')),
        5000,
    );
    signal.addEventListener('abort', abort, { once: true });
    try {
        if (signal.aborted) {
            abort();
        }
        process.stdout.write('controlled-post-approval-preparation\n');
        await stopped.promise;
        signal.throwIfAborted();
        throw new Error('Expected the local prompt signal to abort');
    } finally {
        clearTimeout(timer);
        signal.removeEventListener('abort', abort);
    }
};

await import('../../src/cli/Main.js');
