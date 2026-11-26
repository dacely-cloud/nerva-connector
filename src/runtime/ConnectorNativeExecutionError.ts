// SPDX-FileCopyrightText: 2026 Dacely <business@dacely.com>
// SPDX-License-Identifier: LicenseRef-Proprietary

/** A fixed local diagnostic exposes no private executable path, mount inventory or underlying OS error. */
export class ConnectorNativeExecutionError extends Error {
    /** Source/archive verification does not require execution; actual trusted runtime files do. */
    public constructor() {
        super(
            'Native execution is blocked by permissions or mount options. Put trusted helpers and runtime programs on an exec-enabled filesystem; keep workspace data mounts restricted.',
        );
        this.name = 'ConnectorNativeExecutionError';
    }
}
