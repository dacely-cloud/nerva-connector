// SPDX-FileCopyrightText: 2026 Dacely <business@dacely.com>
// SPDX-License-Identifier: LicenseRef-Proprietary

/** Format changes require the explicit stopped migration; this error never authorizes an automatic old decoder or reset. */
export class ConnectorJournalFormatError extends Error {
    /** Safe actionable copy contains neither host paths nor retained user contents. */
    public constructor() {
        super(
            'Saved command/file state needs an approved stopped upgrade; keep the original files and run nexa connector prepare-history-migration with the original runtime configuration',
        );
        this.name = 'ConnectorJournalFormatError';
    }
}
