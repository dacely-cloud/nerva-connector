// SPDX-FileCopyrightText: 2026 Nerva contributors
// SPDX-License-Identifier: LicenseRef-Proprietary

import type { ConnectorCapturedExecutionEffect } from '../runtime/ConnectorEffectContext.js';
import type { ExecutionCgroupIdentity } from './ExecutionCgroupIdentity.js';

/** The command owner commits the exact newly created group before any native program may be released. */
export interface ExecutionEffectAdmission {
    readonly context: ConnectorCapturedExecutionEffect;
    /** A captured short start window is checked before native effects; running lifetime is separate. */
    readonly expiresAtMs: bigint;
    /** Synchronous trusted validation never refreshes the captured permit or original. */
    readonly assertLaunch: () => void;
    readonly commit: (group: ExecutionCgroupIdentity) => Promise<void>;
}
