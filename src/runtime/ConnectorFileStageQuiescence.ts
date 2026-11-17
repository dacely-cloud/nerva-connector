// SPDX-FileCopyrightText: 2026 Nerva contributors
// SPDX-License-Identifier: LicenseRef-Proprietary

/** Quiescence applies only to private stages captured from the current verified policy, never to unseen old grants. */
export enum ConnectorFileStageQuiescence {
    Quiescent = 'quiescent',
    Busy = 'busy',
    Unknown = 'unknown',
}
