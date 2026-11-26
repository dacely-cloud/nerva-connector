// SPDX-FileCopyrightText: 2026 Dacely <business@dacely.com>
// SPDX-License-Identifier: LicenseRef-Proprietary

import { writeFile } from 'node:fs/promises';
import { randomBytes } from 'node:crypto';
import { join } from 'node:path';
import { ConnectorReleaseFixture } from './ConnectorReleaseFixture.js';
import { ConnectorReleaseInstallation } from '../../src/install/ConnectorReleaseInstallation.js';
import { ConnectorServiceUnit } from '../../src/service/ConnectorServiceUnit.js';
import { ConnectorServiceManager } from '../../src/service/ConnectorServiceManager.js';
import { ConnectorServiceFile } from '../../src/service/ConnectorServiceFile.js';
import {
    ConnectorServiceScope,
    ConnectorServiceOperation,
    ConnectorServiceLoadState,
    ConnectorServiceActiveState,
    ConnectorServiceEnabledState,
    type ConnectorServiceDriver,
    type ConnectorServiceLayout,
    type ConnectorServiceStatus,
} from '../../src/service/ConnectorServiceTypes.js';

/** Controlled manager replies model committed actions with lost acknowledgments; no real local service is changed. */
export class ConnectorServiceFixture implements ConnectorServiceDriver, AsyncDisposable {
    /** Calls retain the exact original derived unit across retries. */
    public readonly commands: ConnectorServiceOperation[] = [];
    /** A manager may commit an operation before its observer fails. */
    public loseReply: ConnectorServiceOperation | null = null;
    /** Loaded overrides cannot be mistaken for the owned unit. */
    public dropInPaths: string = '';
    /** Process state is independent of account online status. */
    public active: boolean = false;
    /** Boot enablement remains independent of current process state. */
    public enabled: boolean = false;
    /** Unit-file enable/disable changes require explicit manager reload before authority can be used. */
    public needsReload: boolean = false;
    /** Registration writes happen in an owned temporary directory, never /etc. */
    public readonly manager: ConnectorServiceManager;
    /** Tests share production layout generation while replacing only the filesystem location and manager boundary. */
    private constructor(
        public readonly release: ConnectorReleaseFixture,
        public readonly layout: ConnectorServiceLayout,
    ) {
        this.manager = new ConnectorServiceManager(layout, this);
    }
    /** A structurally enrolled fixture has no external socket or account authority. */
    public static async create(real: boolean = false): Promise<ConnectorServiceFixture> {
        const release: ConnectorReleaseFixture = await ConnectorReleaseFixture.create(real);
        try {
            const installed: Awaited<ReturnType<typeof ConnectorReleaseInstallation.install>> =
                await ConnectorReleaseInstallation.install(
                    join(release.directory, 'installation.json'),
                    new AbortController().signal,
                );
            const root: string = join(release.directory, 'installed');
            const deployment: typeof release.release.manifest.deployment =
                release.release.manifest.deployment;
            await writeFile(
                installed.runtimeFile,
                JSON.stringify({
                    authorityId: deployment.authorityId,
                    authorityPublicKeyFile: join(root, 'authority-public.json'),
                    environmentId: 'environment',
                    enrollmentId: 'conn_' + randomBytes(32).toString('hex'),
                    slot: 0,
                    endpoints: deployment.endpoints,
                    privateKeyFile: join(root, 'state', 'device-key.json'),
                    serverCaFile: null,
                    files: null,
                    execution: null,
                }),
                { mode: 0o600 },
            );
            const generated: ConnectorServiceLayout = ConnectorServiceUnit.layout(
                root,
                ConnectorServiceScope.System,
            );
            const directory: string = join(release.directory, 'units');
            return new ConnectorServiceFixture(release, {
                ...generated,
                unitDirectory: directory,
                unitFile: join(directory, generated.unitName),
            });
        } catch (caught: unknown) {
            await release[Symbol.asyncDispose]();
            throw caught;
        }
    }
    /** Parsing and real executable checks are covered separately with systemd-analyze. */
    public async verify(layout: ConnectorServiceLayout, signal: AbortSignal): Promise<void> {
        signal.throwIfAborted();
        await ConnectorServiceFile.assertOwned(layout);
    }
    /** A lost reply preserves the manager's changed state rather than rolling back the effect. */
    public command(
        action: ConnectorServiceOperation,
        _layout: ConnectorServiceLayout,
        signal: AbortSignal,
    ): Promise<void> {
        signal.throwIfAborted();
        this.commands.push(action);
        if (action === ConnectorServiceOperation.Enable) {
            this.enabled = true;
            this.needsReload = true;
        }
        if (action === ConnectorServiceOperation.Disable) {
            this.enabled = false;
            this.needsReload = true;
        }
        if (action === ConnectorServiceOperation.Reload) {
            this.needsReload = false;
        }
        if (action === ConnectorServiceOperation.Start) {
            this.active = true;
        }
        if (action === ConnectorServiceOperation.Stop) {
            this.active = false;
        }
        if (this.loseReply === action) {
            this.loseReply = null;
            throw new Error('Controlled manager reply loss');
        }
        return Promise.resolve();
    }
    /** Only explicit manager facts determine observed state. */
    public async status(
        layout: ConnectorServiceLayout,
        signal: AbortSignal,
    ): Promise<ConnectorServiceStatus> {
        signal.throwIfAborted();
        const exists: boolean = await ConnectorServiceFile.exists(layout);
        return {
            scope: layout.scope,
            unitName: layout.unitName,
            load: exists ? ConnectorServiceLoadState.Loaded : ConnectorServiceLoadState.NotFound,
            active: this.active
                ? ConnectorServiceActiveState.Active
                : ConnectorServiceActiveState.Inactive,
            enabled: exists
                ? this.enabled
                    ? ConnectorServiceEnabledState.Enabled
                    : ConnectorServiceEnabledState.Disabled
                : ConnectorServiceEnabledState.Absent,
            mainPid: this.active ? 1234 : exists ? 0 : null,
            restarts: exists ? '9007199254740993' : null,
            fragmentPath: exists ? layout.unitFile : '',
            dropInPaths: this.dropInPaths,
            needsReload: this.needsReload,
        };
    }
    /** All fixture state and temporary app assets are removed; no system unit was created. */
    public async [Symbol.asyncDispose](): Promise<void> {
        await this.release[Symbol.asyncDispose]();
    }
}
