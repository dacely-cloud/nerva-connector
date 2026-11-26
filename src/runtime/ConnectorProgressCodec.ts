// SPDX-FileCopyrightText: 2026 Dacely <business@dacely.com>
// SPDX-License-Identifier: LicenseRef-Proprietary

import type { ConnectorEffectContext } from './ConnectorEffectContext.js';

/** Capability-specific progress validates retained prefixes and their terminal result before atomic persistence. */
export interface ConnectorProgressCodec<TRequest, TResponse, TProgress> {
    read(raw: unknown, request: TRequest, effectContext: ConnectorEffectContext): TProgress;
    advance(previous: TProgress | null, next: TProgress): void;
    finish(progress: TProgress, response: TResponse): void;
}
