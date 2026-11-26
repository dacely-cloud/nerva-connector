// SPDX-FileCopyrightText: 2026 Dacely <business@dacely.com>
// SPDX-License-Identifier: LicenseRef-Proprietary

import { chmod, mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, expect, it, vi, type MockInstance } from 'vitest';
import { WindowsStateExecutable } from '../src/windows/WindowsStateExecutable.js';
import { WindowsStateOwner } from '../src/windows/WindowsStateOwner.js';
import {
    WindowsStateFailure,
    WindowsStateOperation,
    WindowsStatePurpose,
    type WindowsStateResponse,
} from '../src/windows/WindowsStateProtocol.js';

/** What one test changed in its process to run a helper as if on Windows. */
interface FakeWindowsHost {
    readonly directory: string;
    readonly cwd: string;
    readonly systemRoot: string | undefined;
    readonly platform: PropertyDescriptor;
    readonly executable: MockInstance<typeof WindowsStateExecutable.path>;
}

/**
 * Speaks the native line protocol: `gpu-inventory` crashes the helper, `exists-path` is never answered, and leases
 * are known only to the process that issued them.
 */
const answeringHelper: string = [
    "import { createInterface } from 'node:readline';",
    'const leases = new Set();',
    'let issued = 0;',
    'for await (const line of createInterface({ input: process.stdin })) {',
    '    const request = JSON.parse(line);',
    '    const reply = { id: request.id, ok: true, path: null, lease: null, exists: null, names: null,',
    '        dataBase64: null, error: null, sizeBytes: null, sha256: null };',
    "    if (request.operation === 'gpu-inventory') { process.exit(3); }",
    "    if (request.operation === 'exists-path') { continue; }",
    "    if (request.operation === 'root') {",
    '        reply.path = ' + JSON.stringify('C:\\state') + ';',
    "    } else if (request.operation === 'open') {",
    '        issued += 1;',
    "        const token = 'lease' + process.pid + 'n' + issued;",
    '        leases.add(token);',
    '        reply.path = request.path;',
    '        reply.lease = token;',
    '    } else if (leases.has(request.lease)) {',
    "        if (request.operation === 'close') { leases.delete(request.lease); } else { reply.names = ['state']; }",
    '    } else {',
    '        reply.ok = false;',
    "        reply.error = 'invalid';",
    '    }',
    "    process.stdout.write(JSON.stringify(reply) + '\\n');",
    '}',
].join('\n');

/** Exits before answering anything, like a helper whose runtime is missing. */
const silentHelper: string = 'process.exit(1);';

let host: FakeWindowsHost | null = null;

/** Writes one executable helper script into this test's directory. */
async function helper(name: string, body: string): Promise<string> {
    if (host === null) {
        throw new Error('Fake Windows host required');
    }
    const path: string = join(host.directory, name);
    await writeFile(path, '#!' + process.execPath + '\n' + body + '\n', { mode: 0o700 });
    await chmod(path, 0o700);
    return path;
}

/** Leases carry the generation of the helper that issued them. */
function generation(response: WindowsStateResponse): bigint {
    const match: RegExpExecArray | null = /^([1-9][0-9]*)\./u.exec(response.lease ?? '');
    if (match?.[1] === undefined) {
        throw new Error('Generation-tagged lease required');
    }
    return BigInt(match[1]);
}

/** Lets the pending request arm its reply deadline. */
async function settled(): Promise<void> {
    await new Promise<void>((resolve: () => void): void => {
        setImmediate(resolve);
    });
}

beforeEach(async (): Promise<void> => {
    const platform: PropertyDescriptor | undefined = Object.getOwnPropertyDescriptor(
        process,
        'platform',
    );
    if (platform === undefined) {
        throw new Error('Platform descriptor unavailable');
    }
    const directory: string = await mkdtemp(join(homedir(), '.nerva-windows-recovery-'));
    await mkdir(join(directory, 'C:\\Windows'));
    host = {
        directory,
        cwd: process.cwd(),
        systemRoot: process.env['SystemRoot'],
        platform,
        executable: vi.spyOn(WindowsStateExecutable, 'path'),
    };
    process.chdir(directory);
    process.env['SystemRoot'] = 'C:\\Windows';
    Object.defineProperty(process, 'platform', { value: 'win32' });
});

afterEach(async (): Promise<void> => {
    vi.useRealTimers();
    await WindowsStateOwner.close();
    if (host === null) {
        return;
    }
    Object.defineProperty(process, 'platform', host.platform);
    if (host.systemRoot === undefined) {
        delete process.env['SystemRoot'];
    } else {
        process.env['SystemRoot'] = host.systemRoot;
    }
    process.chdir(host.cwd);
    host.executable.mockRestore();
    await rm(host.directory, { recursive: true, force: false });
    host = null;
});

it.skipIf(process.platform !== 'linux')(
    'replaces a stopped helper on the next request and refuses leases that ended with it',
    async (): Promise<void> => {
        host?.executable.mockResolvedValue(await helper('helper.mjs', answeringHelper));
        const directory: string = 'C:\\state';
        expect((await WindowsStateOwner.request(WindowsStateOperation.Root)).path).toBe(directory);
        const first: WindowsStateResponse = await WindowsStateOwner.request(
            WindowsStateOperation.Open,
            { path: directory, purpose: WindowsStatePurpose.Runtime },
        );
        const lease: string = first.lease ?? '';
        expect(
            (await WindowsStateOwner.request(WindowsStateOperation.List, { lease })).names,
        ).toEqual(['state']);

        await expect(
            WindowsStateOwner.request(WindowsStateOperation.GpuInventory),
        ).rejects.toMatchObject({ failure: WindowsStateFailure.Stopped });
        await expect(
            WindowsStateOwner.request(WindowsStateOperation.List, { lease }),
        ).rejects.toMatchObject({ failure: WindowsStateFailure.Stopped });
        await WindowsStateOwner.release(lease);

        const second: WindowsStateResponse = await WindowsStateOwner.request(
            WindowsStateOperation.Open,
            { path: directory, purpose: WindowsStatePurpose.Runtime },
        );
        expect(generation(second)).toBe(generation(first) + 1n);
        const current: string = second.lease ?? '';
        expect(
            (await WindowsStateOwner.request(WindowsStateOperation.List, { lease: current })).names,
        ).toEqual(['state']);
        await expect(
            WindowsStateOwner.request(WindowsStateOperation.List, { lease }),
        ).rejects.toMatchObject({ failure: WindowsStateFailure.Stopped });
        for (const forged of [
            'lease',
            '0.lease',
            (generation(second) + 1n).toString() + '.lease',
            current.slice(current.indexOf('.') + 1),
        ]) {
            await expect(
                WindowsStateOwner.request(WindowsStateOperation.List, { lease: forged }),
            ).rejects.toMatchObject({ failure: WindowsStateFailure.Invalid });
        }

        await WindowsStateOwner.release(current);
        await expect(
            WindowsStateOwner.request(WindowsStateOperation.List, { lease: current }),
        ).rejects.toMatchObject({ failure: WindowsStateFailure.Invalid });
        await expect(WindowsStateOwner.release('lease')).rejects.toMatchObject({
            failure: WindowsStateFailure.Invalid,
        });
    },
    30000,
);

it.skipIf(process.platform !== 'linux')(
    'keeps a helper whose reply was delayed only by a blocked event loop and stops one that stays silent',
    async (): Promise<void> => {
        host?.executable.mockResolvedValue(await helper('helper.mjs', answeringHelper));
        const started: WindowsStateResponse = await WindowsStateOwner.request(
            WindowsStateOperation.Open,
            { path: 'C:\\state', purpose: WindowsStatePurpose.Runtime },
        );
        vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });

        const delayed: Promise<WindowsStateResponse> = WindowsStateOwner.request(
            WindowsStateOperation.Root,
        );
        await settled();
        expect(vi.getTimerCount()).toBe(1);
        const now: () => number = performance.now.bind(performance);
        const clock: MockInstance<typeof performance.now> = vi
            .spyOn(performance, 'now')
            .mockImplementation((): number => now() + 120000);
        try {
            vi.advanceTimersByTime(30000);
        } finally {
            clock.mockRestore();
        }
        expect((await delayed).path).toBe('C:\\state');
        expect(
            (
                await WindowsStateOwner.request(WindowsStateOperation.List, {
                    lease: started.lease ?? '',
                })
            ).names,
        ).toEqual(['state']);

        const silent: Promise<WindowsStateResponse> = WindowsStateOwner.request(
            WindowsStateOperation.ExistsPath,
            { path: 'C:\\state\\pairing.json' },
        );
        await settled();
        vi.advanceTimersByTime(30000);
        await expect(silent).rejects.toMatchObject({ failure: WindowsStateFailure.Stopped });
        await expect(
            WindowsStateOwner.request(WindowsStateOperation.List, { lease: started.lease ?? '' }),
        ).rejects.toMatchObject({ failure: WindowsStateFailure.Stopped });
        vi.useRealTimers();
        expect((await WindowsStateOwner.request(WindowsStateOperation.Root)).path).toBe(
            'C:\\state',
        );
    },
    30000,
);

it.skipIf(process.platform !== 'linux')(
    'reports a helper that exits before answering as unable to start, on every attempt',
    async (): Promise<void> => {
        host?.executable.mockResolvedValue(await helper('silent.mjs', silentHelper));
        for (let attempt: number = 0; attempt < 2; attempt++) {
            await expect(
                WindowsStateOwner.request(WindowsStateOperation.Root),
            ).rejects.toMatchObject({ failure: WindowsStateFailure.Unavailable });
        }
        expect(host?.executable).toHaveBeenCalledTimes(2);
    },
    30000,
);
