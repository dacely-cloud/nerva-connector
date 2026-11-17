// SPDX-FileCopyrightText: 2026 Nerva contributors
// SPDX-License-Identifier: LicenseRef-Proprietary

import type { HostReadObservationSource } from './HostReadObservation.js';

/** Only trusted transport code supplies this reservation; it is never part of a native program's arguments or a model tool schema. */
export interface HostReadObservationStart {
    /** Reserve the generated native identifier before entering a factory that can create a user process. */
    reserve(processId: string): void;
    /** The existing created callback binds the actual retained owner, never a later lookup by identifier. */
    created(source: HostReadObservationSource): void;
}
