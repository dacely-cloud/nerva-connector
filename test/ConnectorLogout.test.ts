// SPDX-FileCopyrightText: 2026 Dacely <business@dacely.com>
// SPDX-License-Identifier: LicenseRef-Proprietary

import { randomUUID, createHash } from 'node:crypto';
import { readFile, rm, readdir } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { beforeEach, afterAll, expect, it, vi, type MockInstance } from 'vitest';
import { Boundary } from 'nerva-connector-protocol/protocol/Boundary.js';
import { ProtectedFiles } from '../src/local/ProtectedFiles.js';
import { ConnectorCloudConfiguration } from '../src/runtime/ConnectorCloudConfiguration.js';
import { ConnectorUnpairTransport } from '../src/runtime/ConnectorUnpairTransport.js';
import { ConnectorLogout } from '../src/runtime/ConnectorLogout.js';
import { ConnectorHostGrant } from '../src/runtime/ConnectorHostGrant.js';
import { ConnectorClientHost } from '../src/runtime/ConnectorClientHost.js';
import type { ConnectorClientIdentity } from '../src/runtime/ConnectorClientConfiguration.js';
import {
    ConnectorDeviceKey,
    type ConnectorDeviceIdentity,
} from '../src/runtime/ConnectorDeviceKey.js';
import {
    ConnectorPairConfiguration,
    type ConnectorPairIdentity,
} from '../src/runtime/ConnectorPairConfiguration.js';
import { ConnectorPairState } from '../src/runtime/ConnectorPairState.js';
import {
    ConnectorPrivateDirectory,
    ConnectorDirectoryPurpose,
} from '../src/runtime/ConnectorPrivateDirectory.js';
import { WindowsStateOwner } from '../src/windows/WindowsStateOwner.js';
import {
    WindowsStateOperation,
    type WindowsStateResponse,
} from '../src/windows/WindowsStateProtocol.js';

const supported: boolean = process.platform === 'linux' || process.platform === 'win32';
afterAll(async (): Promise<void> => {
    if (process.platform === 'win32') {
        await WindowsStateOwner.close();
    }
});

/** Uses the actual Linux owner or Windows Known Folder/DPAPI helper, with no server or real account credentials. */
class LogoutFixture implements AsyncDisposable {
    private constructor(
        public readonly directory: string,
        public readonly file: string,
        public readonly pairing: ConnectorPairIdentity,
        public readonly publicKey: string,
    ) {}

    public static async create(): Promise<LogoutFixture> {
        let parent: string = homedir();
        if (process.platform === 'win32') {
            const result: WindowsStateResponse = await WindowsStateOwner.request(
                WindowsStateOperation.Root,
            );
            if (result.path === null) {
                throw new Error('Native Known Folder required');
            }
            parent = result.path;
        }
        const directory: string = join(parent, '.nerva-logout-' + randomUUID());
        await ProtectedFiles.createDirectory(directory);
        try {
            const file: string = await ConnectorCloudConfiguration.prepare(
                directory,
                new AbortController().signal,
            );
            const pairing: ConnectorPairIdentity = await ConnectorPairConfiguration.load(file);
            const publicKey: string = await ConnectorDeviceKey.initialize(
                join(pairing.settings.stateDirectory, 'device-key.json'),
            );
            const device: ConnectorDeviceIdentity = await ConnectorDeviceKey.load(
                join(pairing.settings.stateDirectory, 'device-key.json'),
            );
            using identity: typeof device.key = device.key;
            await using state: ConnectorPairState = await ConnectorPairState.open(
                pairing.settings.stateDirectory,
                device,
                pairing.configurationSha256,
            );
            expect(identity.publicKey).toBe(publicKey);
            expect(state.snapshot.publicKey).toBe(publicKey);
            return new LogoutFixture(directory, file, pairing, publicKey);
        } catch (caught: unknown) {
            await rm(directory, { recursive: true, force: false });
            throw caught;
        }
    }

    public async [Symbol.asyncDispose](): Promise<void> {
        await rm(this.directory, { recursive: true, force: false });
    }
}

beforeEach((): void => {
    vi.spyOn(ConnectorUnpairTransport, 'run').mockResolvedValue(undefined);
});

it.skipIf(!supported)(
    'confirmed logout preserves full-host consent/history under the retired key and starts the successor metadata-only',
    async (): Promise<void> => {
        await using fixture: LogoutFixture = await LogoutFixture.create();
        const source: string = fixture.pairing.settings.stateDirectory;
        const previous: ConnectorDeviceIdentity = await ConnectorDeviceKey.load(
            join(source, 'device-key.json'),
        );
        using oldKey: typeof previous.key = previous.key;
        const before: ConnectorClientIdentity = {
            configurationFile: join(source, 'device.json'),
            settings: {
                authorityId: fixture.pairing.settings.authorityId,
                authorityPublicKeyFile: fixture.pairing.settings.authorityPublicKeyFile,
                environmentId: 'old-environment',
                enrollmentId: 'conn_' + 'a'.repeat(64),
                slot: 0,
                endpoints: fixture.pairing.settings.endpoints,
                privateKeyFile: join(source, 'device-key.json'),
                serverCaFile: fixture.pairing.settings.serverCaFile,
                files: null,
                execution: null,
            },
            key: oldKey,
            publicKey: previous.publicKey,
            ca: fixture.pairing.ca,
            authority: fixture.pairing.authority,
        };
        await ConnectorHostGrant.install(
            before,
            fixture.directory,
            true,
            new AbortController().signal,
        );
        const history: ReadonlyMap<string, Buffer> = new Map(
            await Promise.all(
                ['grant.json', 'host-journal', 'host-ready'].map(
                    async (name: string): Promise<readonly [string, Buffer]> => [
                        name,
                        await readFile(join(ConnectorHostGrant.directory(before), name)),
                    ],
                ),
            ),
        );
        const nextFile: string = await ConnectorLogout.run(
            fixture.file,
            new AbortController().signal,
        );
        const next: ConnectorPairIdentity = await ConnectorPairConfiguration.load(nextFile);
        const successor: ConnectorDeviceIdentity = await ConnectorDeviceKey.load(
            join(next.settings.stateDirectory, 'device-key.json'),
        );
        using newKey: typeof successor.key = successor.key;
        const after: ConnectorClientIdentity = {
            ...before,
            configurationFile: join(next.settings.stateDirectory, 'device.json'),
            settings: {
                ...before.settings,
                privateKeyFile: join(next.settings.stateDirectory, 'device-key.json'),
                environmentId: 'new-environment',
                enrollmentId: 'conn_' + 'b'.repeat(64),
            },
            key: newKey,
            publicKey: successor.publicKey,
        };
        expect(newKey.publicKey).not.toBe(oldKey.publicKey);
        expect(ConnectorHostGrant.directory(after)).not.toBe(ConnectorHostGrant.directory(before));
        expect(await ConnectorHostGrant.read(after)).toBeNull();
        expect(await ConnectorClientHost.load(after)).toBeNull();
        for (const [name, bytes] of history) {
            expect(await readFile(join(ConnectorHostGrant.directory(before), name))).toEqual(bytes);
        }
        await expect(ConnectorLogout.requireActive(source)).rejects.toThrow('logged out');
    },
);

it.skipIf(!supported)(
    'logout retires old-format authentication locally while preserving the original key and journals, then selects a fresh unprivileged identity',
    async (): Promise<void> => {
        await using fixture: LogoutFixture = await LogoutFixture.create();
        const source: string = fixture.pairing.settings.stateDirectory;
        const keyHash: string = createHash('sha256')
            .update(await readFile(join(source, 'device-key.json')))
            .digest('hex');
        {
            await using state: ConnectorPrivateDirectory = await ConnectorPrivateDirectory.open(
                source,
                ConnectorDirectoryPurpose.Pairing,
            );
            await state.write(
                'device.json',
                Buffer.from('old saved authentication format'),
                16384,
                true,
            );
            await state.write(
                'file-journal',
                Buffer.from('retained operation evidence'),
                16384,
                true,
            );
        }
        const nextFile: string = await ConnectorLogout.run(
            fixture.file,
            new AbortController().signal,
        );
        const next: ConnectorPairIdentity = await ConnectorPairConfiguration.load(nextFile);
        const device: ConnectorDeviceIdentity = await ConnectorDeviceKey.load(
            join(next.settings.stateDirectory, 'device-key.json'),
        );
        using key: typeof device.key = device.key;
        expect(key.publicKey).not.toBe(fixture.publicKey);
        expect(next.settings.files).toBeNull();
        expect(next.settings.execution).toBeNull();
        expect(
            await ConnectorCloudConfiguration.prepare(
                fixture.directory,
                new AbortController().signal,
            ),
        ).toBe(nextFile);
        expect(await ConnectorLogout.run(fixture.file, new AbortController().signal)).toBe(
            nextFile,
        );
        expect(
            (await readdir(fixture.directory)).filter((name: string): boolean =>
                name.startsWith('identity-'),
            ),
        ).toHaveLength(1);
        expect(
            await ConnectorCloudConfiguration.status(
                fixture.directory,
                new AbortController().signal,
            ),
        ).toContain('not linked');
        expect(
            createHash('sha256')
                .update(await readFile(join(source, 'device-key.json')))
                .digest('hex'),
        ).toBe(keyHash);
        expect(await readFile(join(source, 'file-journal'), 'utf8')).toBe(
            'retained operation evidence',
        );
        expect(await readFile(join(source, 'device.json'), 'utf8')).toBe(
            'old saved authentication format',
        );
        await expect(ConnectorLogout.requireActive(source)).rejects.toThrow('logged out');
        const original: ConnectorDeviceIdentity = await ConnectorDeviceKey.load(
            join(source, 'device-key.json'),
        );
        using previousKey: typeof original.key = original.key;
        expect(previousKey.publicKey).toBe(fixture.publicKey);
        await expect(
            ConnectorPairState.open(source, original, fixture.pairing.configurationSha256),
        ).rejects.toThrow('logged out');
    },
);

it.skipIf(!supported)(
    'a live runtime prevents logout and no successor is created until that owner has stopped',
    async (): Promise<void> => {
        await using fixture: LogoutFixture = await LogoutFixture.create();
        {
            await using runtime: ConnectorPrivateDirectory = await ConnectorPrivateDirectory.open(
                fixture.pairing.settings.stateDirectory,
                ConnectorDirectoryPurpose.Runtime,
            );
            expect(runtime.directory).toBe(fixture.pairing.settings.stateDirectory);
            await expect(
                ConnectorLogout.run(fixture.file, new AbortController().signal),
            ).rejects.toThrow();
            expect(
                (await readdir(fixture.directory)).some((name: string): boolean =>
                    name.startsWith('identity-'),
                ),
            ).toBe(false);
        }
        expect(await ConnectorLogout.run(fixture.file, new AbortController().signal)).not.toBe(
            fixture.file,
        );
    },
);

it.skipIf(!supported)(
    'interrupted logout reuses one prepared successor key and retries the original signed retirement',
    async (): Promise<void> => {
        await using fixture: LogoutFixture = await LogoutFixture.create();
        const initialize: typeof ConnectorDeviceKey.initialize =
            ConnectorDeviceKey.initialize.bind(ConnectorDeviceKey);
        const stop: AbortController = new AbortController();
        const spy: MockInstance<typeof initialize> = vi
            .spyOn(ConnectorDeviceKey, 'initialize')
            .mockImplementation(async (path: string): Promise<string> => {
                const result: string = await initialize(path);
                stop.abort(new Error('simulated interrupted logout publication'));
                return result;
            });
        try {
            await expect(ConnectorLogout.run(fixture.file, stop.signal)).rejects.toThrow(
                'interrupted logout',
            );
        } finally {
            spy.mockRestore();
        }
        expect(await ConnectorLogout.resolve(fixture.file, new AbortController().signal)).toBe(
            fixture.file,
        );
        const directories: readonly string[] = (await readdir(fixture.directory)).filter(
            (name: string): boolean => name.startsWith('identity-'),
        );
        expect(directories).toHaveLength(1);
        const directory: string | undefined = directories[0];
        if (directory === undefined) {
            throw new Error('Missing prepared successor');
        }
        const captured: Buffer = await readFile(
            join(fixture.directory, directory, 'device-key.json'),
        );
        const next: string = await ConnectorLogout.run(fixture.file, new AbortController().signal);
        expect(next).toBe(join(fixture.directory, directory, 'pairing.json'));
        expect(await readFile(join(fixture.directory, directory, 'device-key.json'))).toEqual(
            captured,
        );
    },
);

it.skipIf(!supported)(
    'tampered logout pointers cannot select another identity or reset an original journal',
    async (): Promise<void> => {
        await using fixture: LogoutFixture = await LogoutFixture.create();
        await ConnectorLogout.run(fixture.file, new AbortController().signal);
        await using state: ConnectorPrivateDirectory = await ConnectorPrivateDirectory.open(
            fixture.pairing.settings.stateDirectory,
            ConnectorDirectoryPurpose.Pairing,
        );
        const raw: unknown = JSON.parse((await state.read('logout-state', 16384)).toString('utf8'));
        const record: Readonly<Record<string, unknown>> = Boundary.record(raw, [
            'version',
            'configurationSha256',
            'nextDirectory',
            'nextConfigurationSha256',
            'nextPublicKey',
            'signature',
        ]);
        await state.write(
            'logout-state',
            Buffer.from(JSON.stringify({ ...record, nextDirectory: 'identity-' + 'f'.repeat(64) })),
            16384,
            false,
        );
        await state[Symbol.asyncDispose]();
        await expect(
            ConnectorLogout.resolve(fixture.file, new AbortController().signal),
        ).rejects.toThrow('signed identity');
    },
);

it.skipIf(!supported)(
    'an unconfirmed server unpair preserves the original pairing and cannot publish a local logout marker',
    async (): Promise<void> => {
        await using fixture: LogoutFixture = await LogoutFixture.create();
        vi.spyOn(ConnectorUnpairTransport, 'run').mockRejectedValueOnce(
            new Error('server unpair unavailable'),
        );
        await expect(
            ConnectorLogout.run(fixture.file, new AbortController().signal),
        ).rejects.toThrow('server unpair unavailable');
        expect(await ConnectorLogout.resolve(fixture.file, new AbortController().signal)).toBe(
            fixture.file,
        );
        expect(
            await ProtectedFiles.exists(
                join(fixture.pairing.settings.stateDirectory, 'logout-state'),
            ),
        ).toBe(false);
    },
);
