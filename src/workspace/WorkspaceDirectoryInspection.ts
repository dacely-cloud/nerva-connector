// SPDX-FileCopyrightText: 2026 Nerva contributors
// SPDX-License-Identifier: LicenseRef-Proprietary

/** A local owner lends its selected directory and audited helper until the inspection process has closed. */
export interface WorkspaceDirectoryInspection {
    readonly descriptor: number;
    readonly helperDescriptor: number;
    readonly signal: AbortSignal;
}
