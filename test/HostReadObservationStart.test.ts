// SPDX-FileCopyrightText: 2026 Dacely <business@dacely.com>
// SPDX-License-Identifier: LicenseRef-Proprietary

import { afterEach, expect, it, vi, type MockInstance } from 'vitest';
import { HostWorkspaceFixture as Fixture } from './support/HostWorkspaceFixture.js';
import { HostProcess } from '../src/host/HostProcess.js';
import type { HostReadObservationStart } from '../src/host/HostReadObservationStart.js';
import type {
    HostReadObservationSource,
    HostReadObservationState,
} from '../src/host/HostReadObservation.js';
import type { HostProcessRequest, HostProcessSnapshot } from '../src/host/HostWorkspaceTypes.js';

afterEach((): void => {
    vi.restoreAllMocks();
});

/** One short local process makes factory ordering observable without shell interpretation or remote requests. */
function request(): HostProcessRequest {
    return {
        executable: process.execPath,
        arguments: ['-e', 'setTimeout(() => {}, 10000)'],
        directory: null,
        environment: {},
        shell: null,
        command: null,
        timeoutMs: 10000,
    };
}

it('reserves the generated ID before the piped factory can create a user process and binds the actual created owner', async (): Promise<void> => {
    await using fixture: Fixture = await Fixture.create();
    let reserved: string | null = null;
    let created: HostReadObservationState | null = null;
    const original: typeof HostProcess.create = HostProcess.create.bind(HostProcess);
    vi.spyOn(HostProcess, 'create').mockImplementation(
        (...args: Parameters<typeof HostProcess.create>): ReturnType<typeof HostProcess.create> => {
            expect(reserved).toBe(args[0]);
            expect(created).toBeNull();
            return original(...args);
        },
    );
    const reservation: HostReadObservationStart = {
        reserve: (id: string): void => {
            reserved = id;
        },
        created: (source: HostReadObservationSource): void => {
            created = source.state();
            expect(created.processId).toBe(reserved);
        },
    };
    const snapshot: HostProcessSnapshot = await fixture.host.start(request(), 32768, reservation);
    expect(reserved).toBe(snapshot.processId);
    expect(created).toMatchObject({ processId: snapshot.processId, kind: 'process' });
});

it('a failed reservation creates no native owner and restores ordinary startup capacity', async (): Promise<void> => {
    await using fixture: Fixture = await Fixture.create();
    const original: typeof HostProcess.create = HostProcess.create.bind(HostProcess);
    const factory: MockInstance<typeof HostProcess.create> = vi.spyOn(HostProcess, 'create');
    const reservation: HostReadObservationStart = {
        reserve: (): never => {
            throw new Error('protected observation capacity exhausted');
        },
        created: (): never => {
            throw new Error('Native owner cannot exist after failed reservation');
        },
    };
    await expect(fixture.host.start(request(), 32768, reservation)).rejects.toThrow(
        'capacity exhausted',
    );
    expect(factory).not.toHaveBeenCalled();
    factory.mockImplementation(original);
    const ordinary: HostProcessSnapshot = await fixture.host.start(request());
    expect(ordinary.running).toBe(true);
    expect(factory).toHaveBeenCalledOnce();
});
