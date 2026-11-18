// SPDX-FileCopyrightText: 2026 Nerva contributors
// SPDX-License-Identifier: LicenseRef-Proprietary

import type { ConnectorHostErrorCode } from 'nerva-connector-protocol/protocol/ConnectorHost.js';

/** A bounded native error can prove rejection before an operation had effects. */
export class HostOperationError extends Error {
    /** Messages stay local; transport exposes only the bounded code and definitive classification. */
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
