// SPDX-FileCopyrightText: 2026 Nerva contributors
// SPDX-License-Identifier: LicenseRef-Proprietary

import { isBuiltin } from 'node:module';
import { lstat, readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import {
    rolldown,
    type Plugin,
    type RolldownBuild,
    type OutputChunk,
    type OutputAsset,
} from 'rolldown';
import { ConnectorUpdateManifest } from '../src/update/ConnectorUpdateManifest.ts';
import { ConnectorUpdateFiles } from '../src/update/ConnectorUpdateFiles.ts';
import type {
    ConnectorUpdateArchitecture,
    ConnectorUpdatePlatform,
    ConnectorUpdateSettings,
} from '../src/update/ConnectorUpdateProtocol.ts';
import { ConnectorBuildArtifact } from './ConnectorBuildArtifact.ts';
import { ConnectorBuildPaths } from './ConnectorBuildPaths.ts';

/** The offline publisher's public feed configuration, independent of Apple code-signing credentials. */
export interface ConnectorPosixUpdateConfiguration {
    readonly publicKey: string;
    readonly feeds: Readonly<Record<ConnectorUpdatePlatform, string>>;
}

/** Builds a standalone supervisor with fixed authority and native helper commitments; no runtime configuration can broaden it. */
export class ConnectorPosixUpdateBuild {
    /** Loads finite committed public settings and validates both release channels before packaging either one. */
    public static async configuration(): Promise<ConnectorPosixUpdateConfiguration> {
        const path: string = resolve('assets/posix/updates.json');
        if ((await lstat(path)).size > 32768) {
            throw new Error('POSIX update configuration exceeds its bound');
        }
        const raw: unknown = JSON.parse(await readFile(path, 'utf8'));
        const value: Readonly<Record<string, unknown>> = ConnectorUpdateManifest.record(raw, [
            'publicKey',
            'feeds',
        ]);
        const feeds: Readonly<Record<string, unknown>> = ConnectorUpdateManifest.record(
            value['feeds'],
            ['linux', 'darwin'],
        );
        if (
            typeof value['publicKey'] !== 'string' ||
            typeof feeds['linux'] !== 'string' ||
            typeof feeds['darwin'] !== 'string'
        ) {
            throw new Error('Invalid public POSIX update configuration');
        }
        ConnectorUpdateManifest.key(value['publicKey']);
        return {
            publicKey: value['publicKey'],
            feeds: {
                linux: ConnectorUpdateManifest.directory(feeds['linux']).href,
                darwin: ConnectorUpdateManifest.directory(feeds['darwin']).href,
            },
        };
    }

    /** Native builds compile the installed version and closed payload catalog into the updater. */
    public static async settings(
        platform: ConnectorUpdatePlatform,
        architecture: ConnectorUpdateArchitecture,
        version: string,
        helperSha256: string,
    ): Promise<ConnectorUpdateSettings> {
        const configuration: ConnectorPosixUpdateConfiguration = await this.configuration();
        if (!/^[a-f0-9]{64}$/u.test(helperSha256)) {
            throw new Error('Update helper requires its complete SHA-256');
        }
        return {
            version: ConnectorUpdateManifest.version(version),
            platform,
            architecture,
            feedUrl: configuration.feeds[platform],
            publicKey: configuration.publicKey,
            helperSha256,
            files: ConnectorUpdateFiles.names(platform),
        };
    }

    /** Pure settings replacement is the only virtual module; the generated updater imports builtins exclusively. */
    public static async build(
        destination: string,
        settings: ConnectorUpdateSettings,
    ): Promise<void> {
        const entry: string = resolve('src/update/ConnectorUpdateBuildSettings.ts');
        const generated: string = '\0connector-update-settings';
        const plugin: Plugin = {
            name: 'connector-update-settings',
            resolveId(source: string, importer?: string): string | null {
                return importer !== undefined &&
                    source.endsWith('/ConnectorUpdateBuildSettings.js') &&
                    resolve(importer, '..', source.replace(/\.js$/u, '.ts')) === entry
                    ? generated
                    : null;
            },
            load(id: string): string | null {
                return id === generated
                    ? 'export class ConnectorUpdateBuildSettings{static read(){return ' +
                          JSON.stringify(settings) +
                          ';}}'
                    : null;
            },
        };
        const bundle: RolldownBuild = await rolldown({
            input: resolve('src/update/ConnectorUpdateMain.ts'),
            platform: 'node',
            external: (id: string): boolean => isBuiltin(id),
            plugins: [plugin],
        });
        try {
            const result: Awaited<ReturnType<RolldownBuild['generate']>> = await bundle.generate({
                format: 'esm',
                codeSplitting: false,
                minify: true,
                sourcemap: false,
            });
            const output: OutputChunk | OutputAsset | undefined = result.output[0];
            if (
                result.output.length !== 1 ||
                output?.type !== 'chunk' ||
                output.dynamicImports.length !== 0 ||
                !output.imports.every((id: string): boolean => isBuiltin(id)) ||
                Buffer.byteLength(output.code) > 131072 ||
                Object.keys(output.modules).some(
                    (id: string): boolean =>
                        id !== generated &&
                        !id.startsWith('\0') &&
                        !ConnectorBuildPaths.contains(resolve('src'), id),
                )
            ) {
                throw new Error(
                    'Update supervisor must be one finite local module with builtin imports only',
                );
            }
            await ConnectorBuildArtifact.publish(destination, output.code, 0o700);
        } finally {
            await bundle.close();
        }
    }
}
