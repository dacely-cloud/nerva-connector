// SPDX-FileCopyrightText: 2026 Dacely <business@dacely.com>
// SPDX-License-Identifier: LicenseRef-Proprietary

import { ProtectedFiles } from '../local/ProtectedFiles.js';
import { join } from 'node:path';
import { ConnectorServiceRegistration } from './ConnectorServiceRegistration.js';
import {
    ConnectorPrivateDirectory,
    ConnectorDirectoryPurpose,
} from '../runtime/ConnectorPrivateDirectory.js';
import {
    ConnectorInstallation,
    type ConnectorInstallationView,
} from '../install/ConnectorInstallation.js';
import { ConnectorServiceSystemd } from './ConnectorServiceSystemd.js';
import { ConnectorServiceFile } from './ConnectorServiceFile.js';
import {
    ConnectorServicePhase,
    ConnectorServiceOperation,
    ConnectorServiceActiveState,
    ConnectorServiceLoadState,
    type ConnectorServiceLayout,
    type ConnectorServiceRecord,
    type ConnectorServiceStatus,
    type ConnectorServiceDriver,
} from './ConnectorServiceTypes.js';

/** Local intent owns one fixed service across process crashes, manager timeouts and deliberate exact retries. */
export class ConnectorServiceManager {
    /** Production callers construct layout through ConnectorServiceUnit; test drivers never enter public CLI input. */
    public constructor(
        public readonly layout: ConnectorServiceLayout,
        public readonly driver: ConnectorServiceDriver = new ConnectorServiceSystemd(),
    ) {}
    /** Registration and unit bytes agree before the service is enabled; installation never silently starts it. */
    public async install(signal: AbortSignal): Promise<ConnectorServiceStatus> {
        const installed: ConnectorInstallationView = await ConnectorInstallation.read(
            this.layout.installationDirectory,
            signal,
        );
        if (!installed.enrolled) {
            throw new Error('Pair the installed device before registering a service');
        }
        await using owner: ConnectorPrivateDirectory = await this.#owner();
        const original: ConnectorServiceRecord | null = await this.#record(owner);
        if (original?.phase === ConnectorServicePhase.Removing) {
            throw new Error('Finish original service removal first');
        }
        if (original === null && (await ConnectorServiceFile.exists(this.layout))) {
            throw new Error('An unregistered unit already occupies this service name');
        }
        if (
            original === null &&
            (await this.#status(signal)).load !== ConnectorServiceLoadState.NotFound
        ) {
            throw new Error('An unregistered manager unit occupies this name');
        }
        if (original?.phase === ConnectorServicePhase.Installed) {
            await ConnectorServiceFile.assertOwned(this.layout);
            await this.driver.command(ConnectorServiceOperation.Reload, this.layout, signal);
            await this.#status(signal);
            await this.driver.command(ConnectorServiceOperation.Enable, this.layout, signal);
            await this.driver.command(ConnectorServiceOperation.Reload, this.layout, signal);
            return await this.#status(signal);
        }
        await using runtime: AsyncDisposableStack = new AsyncDisposableStack();
        runtime.use(
            await ConnectorPrivateDirectory.open(
                installed.stateDirectory,
                ConnectorDirectoryPurpose.Runtime,
            ),
        );
        await this.#write(owner, ConnectorServicePhase.Installing, original === null);
        await ConnectorServiceFile.publish(this.layout);
        await this.driver.verify(this.layout, signal);
        await this.driver.command(ConnectorServiceOperation.Reload, this.layout, signal);
        await this.#status(signal);
        await this.driver.command(ConnectorServiceOperation.Enable, this.layout, signal);
        await this.driver.command(ConnectorServiceOperation.Reload, this.layout, signal);
        await this.#write(owner, ConnectorServicePhase.Installed, false);
        return await this.#status(signal);
    }
    /** Starting adopts no process or command; the fixed unit's runtime acquires the installation-wide kernel owner. */
    public async start(signal: AbortSignal): Promise<ConnectorServiceStatus> {
        const installed: ConnectorInstallationView = await ConnectorInstallation.read(
            this.layout.installationDirectory,
            signal,
        );
        if (!installed.enrolled) {
            throw new Error('An original enrolled device is required');
        }
        await using owner: ConnectorPrivateDirectory = await this.#owner();
        const record: ConnectorServiceRecord | null = await this.#record(owner);
        if (record?.phase !== ConnectorServicePhase.Installed) {
            throw new Error('Service installation is incomplete');
        }
        await ConnectorServiceFile.assertOwned(this.layout);
        const before: ConnectorServiceStatus = await this.#status(signal);
        if (
            before.active === ConnectorServiceActiveState.Active ||
            before.active === ConnectorServiceActiveState.Activating
        ) {
            return before;
        }
        {
            await using available: AsyncDisposableStack = new AsyncDisposableStack();
            available.use(
                await ConnectorPrivateDirectory.open(
                    installed.stateDirectory,
                    ConnectorDirectoryPurpose.Runtime,
                ),
            );
        }
        await this.driver.command(ConnectorServiceOperation.Start, this.layout, signal);
        return await this.#status(signal);
    }
    /** Observed process state is distinct from the shared API's authenticated device presence. */
    public async status(signal: AbortSignal): Promise<ConnectorServiceStatus> {
        await using owner: ConnectorPrivateDirectory = await this.#owner();
        const record: ConnectorServiceRecord | null = await this.#record(owner);
        if (record !== null && (await ConnectorServiceFile.exists(this.layout))) {
            await ConnectorServiceFile.assertOwned(this.layout);
        }
        return await this.#status(signal);
    }
    /** Startup validates current signed installation and completed local service authority before opening the enrolled transport. */
    public async prepareRuntime(signal: AbortSignal): Promise<ConnectorInstallationView> {
        const installed: ConnectorInstallationView = await ConnectorInstallation.read(
            this.layout.installationDirectory,
            signal,
        );
        if (!installed.enrolled) {
            throw new Error('Service runtime requires the original enrolled device');
        }
        const record: ConnectorServiceRecord = ConnectorServiceRegistration.read(
            await ProtectedFiles.readPrivate(
                join(this.layout.installationDirectory, 'service-state.json'),
                8192,
            ),
            this.layout,
        );
        if (record.phase !== ConnectorServicePhase.Installed) {
            throw new Error('Service registration is incomplete');
        }
        await ConnectorServiceFile.assertOwned(this.layout);
        return installed;
    }
    /** Stop authority depends on the original owned unit, so corrupt app bytes do not prevent stopping that unit. */
    public async stop(signal: AbortSignal): Promise<ConnectorServiceStatus> {
        await using owner: ConnectorPrivateDirectory = await this.#owner();
        if ((await this.#record(owner)) === null) {
            throw new Error('An original service registration is required');
        }
        return await this.#stop(signal);
    }
    /** Removal disables only this unit and preserves every device key, pairing record and capability journal. */
    public async remove(signal: AbortSignal): Promise<ConnectorServiceStatus> {
        await using owner: ConnectorPrivateDirectory = await this.#owner();
        const record: ConnectorServiceRecord | null = await this.#record(owner);
        if (record === null) {
            if (await ConnectorServiceFile.exists(this.layout)) {
                throw new Error('Unregistered service unit cannot be removed');
            }
            const status: ConnectorServiceStatus = await this.#status(signal);
            if (status.load !== ConnectorServiceLoadState.NotFound) {
                throw new Error('Unregistered manager unit cannot be removed');
            }
            return status;
        }
        if (await ConnectorServiceFile.exists(this.layout)) {
            await ConnectorServiceFile.assertOwned(this.layout);
            if (record.phase === ConnectorServicePhase.Removing) {
                await this.driver.command(ConnectorServiceOperation.Reload, this.layout, signal);
            }
            await this.#stop(signal);
            await this.#write(owner, ConnectorServicePhase.Removing, false);
            await this.driver.command(ConnectorServiceOperation.Disable, this.layout, signal);
            await ConnectorServiceFile.remove(this.layout);
        } else if (record.phase !== ConnectorServicePhase.Removing) {
            throw new Error('Original service unit disappeared');
        }
        await this.driver.command(ConnectorServiceOperation.Reload, this.layout, signal);
        const status: ConnectorServiceStatus = await this.#status(signal);
        if (status.load !== ConnectorServiceLoadState.NotFound || !this.#stopped(status)) {
            throw new Error('Service removal has not converged');
        }
        await owner.remove('service-state.json', 8192);
        return status;
    }
    async #stop(signal: AbortSignal): Promise<ConnectorServiceStatus> {
        await ConnectorServiceFile.assertOwned(this.layout);
        const before: ConnectorServiceStatus = await this.#status(signal);
        if (this.#stopped(before)) {
            return before;
        }
        await this.driver.command(ConnectorServiceOperation.Stop, this.layout, signal);
        const after: ConnectorServiceStatus = await this.#status(signal);
        if (!this.#stopped(after)) {
            throw new Error('Service stop is not confirmed');
        }
        return after;
    }
    #stopped(status: ConnectorServiceStatus): boolean {
        return (
            (status.active === ConnectorServiceActiveState.Inactive ||
                status.active === ConnectorServiceActiveState.Failed) &&
            (status.mainPid === 0 ||
                (status.mainPid === null && status.load === ConnectorServiceLoadState.NotFound))
        );
    }
    async #status(signal: AbortSignal): Promise<ConnectorServiceStatus> {
        const status: ConnectorServiceStatus = await this.driver.status(this.layout, signal);
        if (
            status.scope !== this.layout.scope ||
            status.unitName !== this.layout.unitName ||
            status.dropInPaths !== '' ||
            status.needsReload ||
            (status.load !== ConnectorServiceLoadState.NotFound &&
                status.fragmentPath !== this.layout.unitFile)
        ) {
            throw new Error('Service manager selected foreign or changed unit authority');
        }
        return status;
    }
    async #owner(): Promise<ConnectorPrivateDirectory> {
        return await ConnectorPrivateDirectory.open(
            this.layout.installationDirectory,
            ConnectorDirectoryPurpose.Service,
        );
    }
    async #record(owner: ConnectorPrivateDirectory): Promise<ConnectorServiceRecord | null> {
        if (!(await owner.exists('service-state.json'))) {
            return null;
        }
        return ConnectorServiceRegistration.read(
            await owner.read('service-state.json', 8192),
            this.layout,
        );
    }
    async #write(
        owner: ConnectorPrivateDirectory,
        phase: ConnectorServicePhase,
        initialize: boolean,
    ): Promise<void> {
        await owner.cleanPartial('service-state.json', 8192);
        const record: ConnectorServiceRecord = {
            scope: this.layout.scope,
            unitName: this.layout.unitName,
            sha256: this.layout.sha256,
            phase,
        };
        await owner.write(
            'service-state.json',
            Buffer.from(JSON.stringify(record)),
            8192,
            initialize,
        );
    }
}
