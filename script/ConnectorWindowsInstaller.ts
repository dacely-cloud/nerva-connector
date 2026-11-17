// SPDX-FileCopyrightText: 2026 Nerva contributors
// SPDX-License-Identifier: LicenseRef-Proprietary

import { mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises';
import { basename, join, resolve } from 'node:path';
import { ConnectorWindowsSources } from './ConnectorWindowsSources.ts';
import { ConnectorWindowsCompiler } from './ConnectorWindowsCompiler.ts';
import {
    ConnectorWindowsPayload,
    type ConnectorWindowsPayloadFile,
} from './ConnectorWindowsPayload.ts';
import { ConnectorWindowsResource } from './ConnectorWindowsResource.ts';
import { ConnectorWindowsUninstaller } from './ConnectorWindowsUninstaller.ts';

/** Where installed copies look for updates and the release key that must have signed them. */
export interface ConnectorWindowsUpdateSettings {
    /** The HTTPS directory holding latest.json, latest.json.sig and the setup programs, ending in a slash. */
    readonly feedUrl: string;
    /** The release key's public half as an RSA key value XML document. */
    readonly publicKeyXml: string;
}

/** What one Windows setup program is built from. */
export interface ConnectorWindowsInstallerInput {
    /** An empty build-owned working directory; it is removed afterwards. */
    readonly work: string;
    /** The setup program to publish. */
    readonly destination: string;
    /** The version setup records in Settings, Apps. */
    readonly version: string;
    /** The Windows architecture the bundled node.exe runs on, which the update check asks for. */
    readonly architecture: string;
    /** The update feed, or `null` to build copies that never look for updates. */
    readonly updates: ConnectorWindowsUpdateSettings | null;
    /** The connector, its helpers and its Node runtime; the launcher and uninstaller are added here. */
    readonly files: readonly ConnectorWindowsPayloadFile[];
}

/**
 * Compiles the Windows setup program: the background program and uninstaller, then setup carrying both and every
 * given file.
 *
 * @remarks
 * Each program gets its own icon, manifest and version information. The background program, "Nerva Connector.exe",
 * also gets the update feed and release key as compiled constants. NSIS builds the standard native uninstaller
 * with an explicit list of installed program files. Only the setup program is published; every
 * intermediate is written inside `work`, which is removed whether the build succeeds or fails.
 */
export class ConnectorWindowsInstaller {
    /** The background program's installed name; shortcuts and the sign-in setting start it. */
    public static readonly launcher: string = 'Nerva Connector.exe';
    /** The uninstaller's installed name; Settings, Apps runs it. */
    public static readonly uninstaller: string = 'Uninstall Nerva Connector.exe';
    /** License notices distributed with the native uninstall engine. */
    public static readonly uninstallerLicense: string = 'NSIS-LICENSE.txt';

    /** Builds and publishes the setup program. */
    public static async build(input: ConnectorWindowsInstallerInput): Promise<void> {
        const icon: Buffer = await readFile(resolve('assets/windows/nerva-connector.ico'));
        await mkdir(input.work, { recursive: true, mode: 0o700 });
        try {
            const launcher: string = join(input.work, this.launcher);
            const uninstaller: string = join(input.work, this.uninstaller);
            const settings: string = join(input.work, 'UpdateSettings.cs');
            await writeFile(settings, this.settings(input), { mode: 0o600 });
            await ConnectorWindowsCompiler.compile({
                sources: [...ConnectorWindowsSources.supervisor, settings],
                entrypoint: 'NexaConnectorSupervisorProgram',
                destination: launcher,
                target: 'winexe',
                references: ['System.Windows.Forms'],
                win32Resource: await this.#resource(input, icon, 'Nerva Connector', this.launcher),
                resources: [
                    {
                        file: resolve('assets/windows/nerva-connector.ico'),
                        name: 'NexaConnector.Icon',
                    },
                ],
            });
            const setupSources: readonly string[] = ConnectorWindowsSources.setup;
            await ConnectorWindowsUninstaller.build({
                work: input.work,
                destination: uninstaller,
                version: input.version,
                files: [
                    this.launcher,
                    this.uninstallerLicense,
                    ...input.files.map((file: ConnectorWindowsPayloadFile): string => file.name),
                ],
            });
            const payload: string = join(input.work, 'payload.bin');
            await ConnectorWindowsPayload.write(payload, input.version, [
                { name: this.launcher, source: launcher },
                { name: this.uninstaller, source: uninstaller },
                {
                    name: this.uninstallerLicense,
                    source: resolve('assets/windows/nsis-license.txt'),
                },
                ...input.files,
            ]);
            const partial: string = join(input.work, 'setup.exe');
            await ConnectorWindowsCompiler.compile({
                sources: setupSources,
                entrypoint: 'NexaConnectorSetup',
                destination: partial,
                target: 'winexe',
                references: ['System.Windows.Forms'],
                win32Resource: await this.#resource(
                    input,
                    icon,
                    'Nerva Connector Setup',
                    basename(input.destination),
                ),
                resources: [
                    { file: payload, name: 'NexaConnector.Payload' },
                    {
                        file: resolve('assets/windows/nerva-connector-logo.png'),
                        name: 'NexaConnector.Logo',
                    },
                ],
            });
            await rename(partial, input.destination);
        } finally {
            await rm(input.work, { recursive: true, force: true });
        }
    }

    /**
     * The C# constants the background program reads its version, architecture and update feed from.
     *
     * @remarks
     * Every value is checked before it is written into source, so nothing in it can end a string literal.
     */
    public static settings(
        input: Pick<ConnectorWindowsInstallerInput, 'version' | 'architecture' | 'updates'>,
    ): string {
        const feed: string = input.updates?.feedUrl ?? '';
        const key: string = input.updates?.publicKeyXml ?? '';
        if (
            !/^[0-9]+\.[0-9]+\.[0-9]+$/u.test(input.version) ||
            !/^(x64|arm64)$/u.test(input.architecture) ||
            !(
                feed === '' ||
                /^https:\/\/[A-Za-z0-9.-]+(:[0-9]{1,5})?(\/[A-Za-z0-9._~-]+)*\/$/u.test(feed)
            ) ||
            !(
                key === '' ||
                /^<RSAKeyValue><Modulus>[A-Za-z0-9+/=]+<\/Modulus><Exponent>[A-Za-z0-9+/=]+<\/Exponent><\/RSAKeyValue>$/u.test(
                    key,
                )
            )
        ) {
            throw new Error('Invalid Windows update settings');
        }
        return [
            '/// <summary>Compiled by script/ConnectorWindowsInstaller.ts for one setup program.</summary>',
            'internal static class NexaConnectorUpdateSettings',
            '{',
            `    internal const string Version = "${input.version}";`,
            `    internal const string Architecture = "${input.architecture}";`,
            `    internal const string FeedUrl = "${feed}";`,
            `    internal const string PublicKeyXml = "${key}";`,
            '}',
            '',
        ].join('\n');
    }

    static async #resource(
        input: ConnectorWindowsInstallerInput,
        icon: Buffer,
        description: string,
        fileName: string,
    ): Promise<string> {
        const path: string = join(input.work, fileName.replace(/[^A-Za-z0-9.-]+/gu, '-') + '.res');
        await writeFile(
            path,
            ConnectorWindowsResource.build(icon, {
                description,
                fileName,
                version: input.version,
            }),
            { mode: 0o600 },
        );
        return path;
    }
}
