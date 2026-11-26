// SPDX-FileCopyrightText: 2026 Dacely <business@dacely.com>
// SPDX-License-Identifier: LicenseRef-Proprietary

import type { BigIntStats } from 'node:fs';

/** One exact metadata identity/version contract serves stat and opened-descriptor revalidation. */
export class HostFileIdentity {
    /** Metadata identity does not claim an immutable generation or replace a content digest. */
    public static from(metadata: BigIntStats): string {
        return [
            'host-file-v1',
            metadata.dev.toString(),
            metadata.ino.toString(),
            metadata.birthtimeNs.toString(),
            metadata.ctimeNs.toString(),
        ].join(':');
    }
}
