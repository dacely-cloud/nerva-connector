// SPDX-FileCopyrightText: 2026 Dacely <business@dacely.com>
// SPDX-License-Identifier: LicenseRef-Proprietary

/** The source digest commits the exact encrypted original, not a re-encoded plaintext approximation. */
export interface ConnectorJournalRecord<TState> {
    readonly state: TState;
    readonly sourceSha256: string;
}
