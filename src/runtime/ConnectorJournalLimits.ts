// SPDX-FileCopyrightText: 2026 Nerva contributors
// SPDX-License-Identifier: LicenseRef-Proprietary

/** Existing payload bounds retain finite headroom for mandatory local provenance metadata without truncation. */
export class ConnectorJournalLimits {
    /** The original valid plaintext ceiling remains the migration source bound. */
    public static readonly originalPlainBytes: number = 131072;
    /** Current authority retains the full bounded descriptor, private effect context and exact correlation metadata. */
    public static readonly plainBytes: number = 147456;
    /** Canonical base64url encryption of the maximum current plaintext remains finite. */
    public static readonly encodedCharacters: number = 196608;
    /** The finite outer record includes authenticated encryption metadata and canonical base64url. */
    public static readonly recordBytes: number = 200704;
}
