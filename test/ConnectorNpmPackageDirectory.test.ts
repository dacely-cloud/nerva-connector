// SPDX-FileCopyrightText: 2026 Nerva contributors
// SPDX-License-Identifier: LicenseRef-Proprietary

import { expect, it, vi, type MockInstance } from 'vitest';
import { ConnectorNpmPackageDirectory } from '../script/ConnectorNpmPackageDirectory.ts';
import { ProtectedFiles } from '../src/local/ProtectedFiles.js';
import { WindowsStateError, WindowsStateFailure } from '../src/windows/WindowsStateProtocol.js';

it('Windows publisher output preserves native missing/permission failures and never repairs an inherited or foreign DACL', async (): Promise<void> => {
    const descriptor: PropertyDescriptor | undefined = Object.getOwnPropertyDescriptor(
        process,
        'platform',
    );
    if (descriptor === undefined) {
        throw new Error('Isolated fixture requires the runtime platform descriptor');
    }
    const directory: MockInstance<typeof ProtectedFiles.directory> = vi.spyOn(
        ProtectedFiles,
        'directory',
    );
    const create: MockInstance<typeof ProtectedFiles.createDirectory> = vi.spyOn(
        ProtectedFiles,
        'createDirectory',
    );
    try {
        Object.defineProperty(process, 'platform', { value: 'win32' });
        directory.mockResolvedValue(undefined);
        await ConnectorNpmPackageDirectory.create('C:\\ProtectedPublisher\\npm');
        expect(create).not.toHaveBeenCalled();

        directory.mockRejectedValue(new WindowsStateError(WindowsStateFailure.Untrusted));
        await expect(
            ConnectorNpmPackageDirectory.create('C:\\InheritedPublisher\\npm'),
        ).rejects.toMatchObject({
            failure: WindowsStateFailure.Untrusted,
        });
        expect(create).not.toHaveBeenCalled();

        directory.mockRejectedValue(new WindowsStateError(WindowsStateFailure.Missing));
        create.mockRejectedValue(new WindowsStateError(WindowsStateFailure.Untrusted));
        await expect(
            ConnectorNpmPackageDirectory.create('C:\\OutsideManagedRoot\\npm'),
        ).rejects.toMatchObject({
            failure: WindowsStateFailure.Untrusted,
        });
        expect(create).toHaveBeenCalledExactlyOnceWith('C:\\OutsideManagedRoot\\npm');

        create.mockClear();
        create.mockResolvedValue(undefined);
        await ConnectorNpmPackageDirectory.create(
            'C:\\Users\\Owner\\AppData\\Local\\Nerva\\Connector\\publisher\\npm',
        );
        expect(create).toHaveBeenCalledExactlyOnceWith(
            'C:\\Users\\Owner\\AppData\\Local\\Nerva\\Connector\\publisher\\npm',
        );
    } finally {
        Object.defineProperty(process, 'platform', descriptor);
        directory.mockRestore();
        create.mockRestore();
    }
});
