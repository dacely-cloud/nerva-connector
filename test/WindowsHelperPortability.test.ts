// SPDX-FileCopyrightText: 2026 Nerva contributors
// SPDX-License-Identifier: LicenseRef-Proprietary

import { readdir, readFile } from 'node:fs/promises';
import { join, relative } from 'node:path';
import { expect, it } from 'vitest';

/** A source pattern whose Mono binding has no .NET Framework 4.x member. */
interface WindowsHelperHazard {
    readonly pattern: RegExp;
    readonly reason: string;
}

/**
 * Linux cross-compilation binds against Mono's class library, which adds overloads and type
 * locations that .NET Framework 4.x lacks; such references fail only when Windows loads them.
 */
const hazards: readonly WindowsHelperHazard[] = [
    {
        pattern: /\.(?:Split|Trim|TrimStart|TrimEnd)\(\s*'/u,
        reason: 'single-char overloads bind to Mono-only members; pass a char[]',
    },
    {
        pattern: /\.(?:Contains|StartsWith|EndsWith|IndexOfAny)\(\s*'[^']*'\s*[,)]/u,
        reason: 'char overloads of these string members are absent from .NET Framework',
    },
    {
        pattern: /String\.Join\(\s*'/u,
        reason: 'String.Join(char, ...) is absent from .NET Framework',
    },
    {
        pattern: /\b(?:Queue|Stack|LinkedList)</u,
        reason: 'Mono resolves these from mscorlib while .NET Framework defines them in System.dll',
    },
];

async function sources(directory: string): Promise<readonly string[]> {
    const files: string[] = [];
    for (const entry of await readdir(directory, { withFileTypes: true })) {
        const path: string = join(directory, entry.name);
        if (entry.isDirectory()) {
            files.push(...(await sources(path)));
        } else if (entry.name.endsWith('.cs')) {
            files.push(path);
        }
    }
    return files;
}

it('Windows helper sources avoid APIs whose Linux cross-compiled references fail on .NET Framework', async (): Promise<void> => {
    const roots: readonly string[] = ['native/windows', 'test/support'];
    const findings: string[] = [];
    for (const root of roots) {
        for (const file of await sources(root)) {
            const lines: readonly string[] = (await readFile(file, 'utf8')).split('\n');
            lines.forEach((line: string, index: number): void => {
                for (const hazard of hazards) {
                    if (hazard.pattern.test(line)) {
                        findings.push(
                            relative('.', file) + ':' + String(index + 1) + ' ' + hazard.reason,
                        );
                    }
                }
            });
        }
    }
    expect(findings).toEqual([]);
});
