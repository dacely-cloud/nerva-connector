// SPDX-FileCopyrightText: 2026 Dacely <business@dacely.com>
// SPDX-License-Identifier: LicenseRef-Proprietary

import { expect, it } from 'vitest';
import { ConnectorStorageAdvice } from '../src/cli/ConnectorStorageAdvice.js';
import { WindowsStateCheck, WindowsStateScope } from '../src/windows/WindowsStateProtocol.js';

it('every Windows storage check names its folder and a repair', (): void => {
    for (const scope of Object.values(WindowsStateScope)) {
        for (const check of Object.values(WindowsStateCheck)) {
            const lines: readonly string[] = ConnectorStorageAdvice.lines(`${scope}/${check}`);
            expect(lines).toHaveLength(2);
            expect(lines[0]).toMatch(/^Folder: /u);
            expect(lines[1]).toMatch(/^Problem: .+ Fix: /u);
        }
    }
});

it('names the folders behind the refusals seen on a Windows 0.1.17 install', (): void => {
    expect(ConnectorStorageAdvice.lines('profile-ancestor/unexpected-permission')[0]).toBe(
        'Folder: your user profile folder, %USERPROFILE%, or the folder above it, such as C:\\Users',
    );
    expect(ConnectorStorageAdvice.lines('connector-state/unexpected-permission')[0]).toContain(
        '%USERPROFILE%\\.nerva-connector-state',
    );
    expect(ConnectorStorageAdvice.lines('other-directory/unexpected-permission')[1]).toContain(
        'icacls "<folder>" /remove "<account>"',
    );
});
