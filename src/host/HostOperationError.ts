// SPDX-FileCopyrightText: 2026 Dacely <business@dacely.com>
// SPDX-License-Identifier: LicenseRef-Proprietary

import type { ConnectorHostErrorCode } from 'nerva-connector-protocol/protocol/ConnectorHost.js';

/** A bounded native error can prove rejection before an operation had effects. */
export class HostOperationError extends Error {
    /** Use fixed diagnostic prose without command arguments or paths. The paired relay receives only the code and effect classification. */
    public constructor(
        public readonly code: ConnectorHostErrorCode,
        message: string,
        public readonly definitive: boolean,
        options?: ErrorOptions,
    ) {
        super(message, options);
        this.name = 'HostOperationError';
    }
}
