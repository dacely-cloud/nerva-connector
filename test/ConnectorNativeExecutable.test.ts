// SPDX-FileCopyrightText: 2026 Nerva contributors
// SPDX-License-Identifier: LicenseRef-Proprietary

import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';
import { expect, it } from 'vitest';
import { ConnectorNativeExecutionError } from '../src/runtime/ConnectorNativeExecutionError.js';

/** Bounded subprocess output consists only of fixed proof labels and cleanup receipts. */
interface NativeMountResult {
    readonly stdout: string;
    readonly stderr: string;
}

it.skipIf(process.platform !== 'linux' || process.getuid?.() !== 0)(
    'actual private exec/noexec mounts distinguish source verification from same-FD runtime admission without closing borrowed capabilities',
    async (): Promise<void> => {
        const result: NativeMountResult = await promisify(execFile)(
            'python3',
            [
                '-I',
                '-B',
                fileURLToPath(new URL('./support/native_execution_mount.py', import.meta.url)),
                process.execPath,
            ],
            { timeout: 15000, maxBuffer: 65536 },
        );
        expect(result.stderr).toBe('');
        expect(result.stdout).toContain(
            'NERVA_NATIVE_EXEC_PREFLIGHT {"execAccepted":true,"noexecSourceVerified":true,"noexecRuntimeDenied":true,"pinnedObjectRetained":true,"permissionsRechecked":true,"borrowedOwnershipRetained":true}',
        );
        expect(result.stdout).toContain(
            'NERVA_NATIVE_EXEC_PREFLIGHT_CLEANUP namespace_joined=true mounts_removed=true temporary_files_removed=true',
        );
    },
);

it('the allowlisted runtime error has fixed actionable copy without a private path or arbitrary OS detail', (): void => {
    const error: ConnectorNativeExecutionError = new ConnectorNativeExecutionError();
    expect(error.message).toContain('permissions or mount options');
    expect(error.message).toContain('trusted helpers and runtime programs');
    expect(error.message).toContain('keep workspace data mounts restricted');
    expect(error.message).not.toContain('/');
    expect(error.name).toBe('ConnectorNativeExecutionError');
});
