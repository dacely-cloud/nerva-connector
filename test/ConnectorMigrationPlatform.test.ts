// SPDX-FileCopyrightText: 2026 Nerva contributors
// SPDX-License-Identifier: LicenseRef-Proprietary

import { expect, it } from 'vitest';
import { ConnectorMigrationPlatform } from '../src/runtime/ConnectorMigrationPlatform.js';
import type { ConnectorClientSettings } from '../src/runtime/ConnectorClientSettings.js';

const paired: ConnectorClientSettings = {
    authorityId: 'fixture-authority',
    authorityPublicKeyFile: '/fixture/public.json',
    environmentId: 'fixture-environment',
    enrollmentId: 'conn_' + 'a'.repeat(64),
    slot: 0,
    endpoints: ['wss://fixture.invalid/v1/connector/tunnel'],
    privateKeyFile: '/fixture/device-key.json',
    serverCaFile: null,
    files: null,
    execution: null,
};
const files: NonNullable<ConnectorClientSettings['files']> = {
    policyFile: '/fixture/file-policy.json',
    stateDirectory: '/fixture/file-state',
};
const execution: NonNullable<ConnectorClientSettings['execution']> = {
    policyFile: '/fixture/command-policy.json',
    stateDirectory: '/fixture/command-state',
};

it('permits Windows and macOS identity-only conversion without implying operation-journal or program capabilities', (): void => {
    for (const platform of ['win32', 'darwin'] as const) {
        expect((): void => ConnectorMigrationPlatform.validate(platform, paired)).not.toThrow();
        for (const settings of [
            { ...paired, files },
            { ...paired, execution },
            { ...paired, files, execution },
        ]) {
            expect((): void => ConnectorMigrationPlatform.validate(platform, settings)).toThrow(
                'operation-journal ownership',
            );
        }
    }
});

it('retains Linux ownership admission and rejects platforms without either supported native owner', (): void => {
    expect((): void =>
        ConnectorMigrationPlatform.validate('linux', { ...paired, files, execution }),
    ).not.toThrow();
    for (const platform of ['freebsd', 'aix'] as const) {
        expect((): void => ConnectorMigrationPlatform.validate(platform, paired)).toThrow();
    }
});
