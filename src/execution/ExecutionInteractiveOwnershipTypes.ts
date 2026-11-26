// SPDX-FileCopyrightText: 2026 Dacely <business@dacely.com>
// SPDX-License-Identifier: LicenseRef-Proprietary

import type {
    ExecutionInteractiveInvocationRule,
    ExecutionInteractiveLaunch,
} from 'nerva-connector-protocol/execution/ExecutionInteractiveInvocation.js';
import type { ExecutionNativePipeHandle } from './ExecutionNativePipeHandle.js';
import type { ExecutionInputAcknowledgment } from 'nerva-connector-protocol/execution/ExecutionInput.js';
import type { ExecutionInputReceiptCapture } from 'nerva-connector-protocol/execution/ExecutionInputReceiptCapture.js';

/** Local pinned program resolution, rather than a transport flag, creates this explicit interactive intent. */
export interface ExecutionInteractiveResolution {
    readonly rule: ExecutionInteractiveInvocationRule;
    readonly launch: ExecutionInteractiveLaunch;
}

/** Sandbox owns the child and group; these callbacks join the corresponding signed input owner. */
export interface ExecutionInteractiveNativeBinding {
    readonly pipe: ExecutionNativePipeHandle;
    readonly incarnation: string;
    readonly ready: () => Promise<boolean>;
    readonly completed: () => Promise<void>;
}

/** Delivery receives a context-complete durable receipt, never the authority to invent its prior cursor. */
export interface ExecutionInteractiveDeliveryReply {
    readonly acknowledgment: ExecutionInputAcknowledgment | null;
    readonly completion: ExecutionInputReceiptCapture | null;
}
