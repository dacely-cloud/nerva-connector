// SPDX-FileCopyrightText: 2026 Nerva contributors
// SPDX-License-Identifier: LicenseRef-Proprietary

import type { ExecutionClient } from './ExecutionClient.js';

/** Delivery borrows the verified execution owner without receiving policy loading or native construction authority. */
export interface ExecutionDeliveryClient
    extends
        Pick<
            ExecutionClient,
            | 'failed'
            | 'observeOutput'
            | 'observeInteractive'
            | 'interactiveReady'
            | 'input'
            | 'output'
            | 'verifyOutputAck'
            | 'execute'
            | 'cancel'
            | 'acknowledge'
        >,
        AsyncDisposable {}
