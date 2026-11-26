// SPDX-FileCopyrightText: 2026 Dacely <business@dacely.com>
// SPDX-License-Identifier: LicenseRef-Proprietary

import { resolve } from 'node:path';
import { expect, it } from 'vitest';
import { ConnectorReleasePreparationArguments } from '../script/ConnectorReleasePreparationArguments.js';

it('release source options preserve old config-only and explicit publisher invocations', (): void => {
    const configuration: string = resolve('protected-config.json');
    const destination: string = resolve('publisher');
    expect(ConnectorReleasePreparationArguments.read(['--config', configuration])).toEqual({
        configuration,
        destination: null,
        artifactsDirectory: null,
    });
    expect(
        ConnectorReleasePreparationArguments.read([
            '--config',
            configuration,
            '--output-directory',
            destination,
        ]),
    ).toEqual({ configuration, destination, artifactsDirectory: null });
});

it('release source and publisher directories are independently explicit in either optional argument order', (): void => {
    const configuration: string = resolve('protected-config.json');
    const destination: string = resolve('publisher');
    const artifactsDirectory: string = resolve('build');
    for (const options of [
        ['--output-directory', destination, '--artifacts-directory', artifactsDirectory],
        ['--artifacts-directory', artifactsDirectory, '--output-directory', destination],
    ]) {
        expect(
            ConnectorReleasePreparationArguments.read(['--config', configuration, ...options]),
        ).toEqual({ configuration, destination, artifactsDirectory });
    }
});

it('release preparation refuses unknown, duplicate, relative, noncanonical or incomplete source options', (): void => {
    const configuration: string = resolve('protected-config.json');
    for (const args of [
        [],
        ['--config'],
        ['--output-directory', resolve('publisher')],
        ['--config', configuration, '--source', resolve('build')],
        ['--config', configuration, '--config', configuration],
        ['--config', configuration, '--artifacts-directory', 'relative'],
        ['--config', configuration, '--artifacts-directory', resolve('build') + '/./child'],
        [
            '--config',
            configuration,
            '--artifacts-directory',
            resolve('build'),
            '--artifacts-directory',
            resolve('other'),
        ],
    ]) {
        expect((): void => {
            ConnectorReleasePreparationArguments.read(args);
        }).toThrow();
    }
});
