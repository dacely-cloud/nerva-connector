// SPDX-FileCopyrightText: 2026 Dacely <business@dacely.com>
// SPDX-License-Identifier: LicenseRef-Proprietary

import { readFile, writeFile, stat } from 'node:fs/promises';
import { join } from 'node:path';
import { setTimeout } from 'node:timers/promises';
import { expect, it } from 'vitest';
import { HostWorkspace } from '../src/host/HostWorkspace.js';
import { HostWorkspaceFixture } from './support/HostWorkspaceFixture.js';
import { HostByteRing } from '../src/host/HostByteRing.js';
import {
    HostFileKind,
    HostProcessFailure,
    HostWorkspaceLimits,
    type HostWorkspaceAccess,
    type HostWorkspaceAuthorization,
    type HostProcessRequest,
    type HostProcessSnapshot,
    type HostFileRead,
} from '../src/host/HostWorkspaceTypes.js';
import {
    ConnectorHostShell,
    ConnectorHostWriteMode,
} from 'nerva-connector-protocol/protocol/ConnectorHostArgumentChoices.js';

/** Piped Node fixtures exercise argument vectors, binary I/O, environment and normal host permissions. */
function command(source: string, timeoutMs: number = 10000): HostProcessRequest {
    return {
        executable: process.execPath,
        arguments: ['-e', source],
        shell: null,
        command: null,
        directory: null,
        environment: {},
        timeoutMs,
    };
}

/** Poll the same owned process rather than submitting replacement work. */
async function finished(host: HostWorkspace, processId: string): Promise<HostProcessSnapshot> {
    let result: HostProcessSnapshot = await host.output(
        processId,
        0n,
        0n,
        HostWorkspaceLimits.chunkBytes,
    );
    for (let attempt: number = 0; result.running && attempt < 150; attempt += 1) {
        await setTimeout(20);
        result = await host.output(processId, 0n, 0n, HostWorkspaceLimits.chunkBytes);
    }
    expect(result.running).toBe(false);
    return result;
}

it('host files preserve chunks, update offsets, append, list pages and enforce fresh authority', async (): Promise<void> => {
    await using fixture: HostWorkspaceFixture = await HostWorkspaceFixture.create();
    await fixture.host.mkdir('nested', false);
    expect(
        await fixture.host.write(
            'nested/file.bin',
            Buffer.from('abc'),
            ConnectorHostWriteMode.Create,
            0n,
        ),
    ).toBe(3n);
    await fixture.host.write(
        'nested/file.bin',
        Buffer.from('Z'),
        ConnectorHostWriteMode.Update,
        1n,
    );
    await fixture.host.write(
        'nested/file.bin',
        Buffer.from('!'),
        ConnectorHostWriteMode.Append,
        0n,
    );
    const first: HostFileRead = await fixture.host.read('nested/file.bin', 0n, 2);
    expect(first).toMatchObject({ offset: 0n, nextOffset: 2n, size: 4n, eof: false });
    expect(first.bytes.toString()).toBe('aZ');
    expect((await fixture.host.read('nested/file.bin', 2n, 2)).bytes.toString()).toBe('c!');
    expect(await fixture.host.stat('nested/file.bin')).toMatchObject({
        kind: HostFileKind.File,
        size: 4n,
    });
    await fixture.host.write(
        'nested/other.bin',
        Buffer.from('other'),
        ConnectorHostWriteMode.Create,
        0n,
    );
    expect((await fixture.host.list('nested', 0, 1)).nextOffset).toBe(1);
    expect((await fixture.host.list('nested', 1, 1)).nextOffset).toBeNull();
    fixture.allowed = false;
    await expect(fixture.host.read('nested/file.bin', 0n, 8)).rejects.toThrow('revoked');
    await expect(
        fixture.host.write(
            'nested/file.bin',
            Buffer.from('bad'),
            ConnectorHostWriteMode.Replace,
            0n,
        ),
    ).rejects.toThrow('revoked');
    expect(await readFile(join(fixture.directory, 'nested/file.bin'), 'utf8')).toBe('aZc!');
    fixture.allowed = true;
    await expect(
        fixture.host.write(
            'nested/file.bin',
            Buffer.from('bad'),
            ConnectorHostWriteMode.Create,
            0n,
        ),
    ).rejects.toThrow();
    await expect(
        fixture.host.write(
            'nested/file.bin',
            Buffer.from('bad'),
            ConnectorHostWriteMode.Update,
            9007199254740992n,
        ),
    ).rejects.toThrow('exact range');
    await fixture.host.remove('nested', true);
    await expect(stat(join(fixture.directory, 'nested'))).rejects.toThrow();
});

it('host commands preserve cwd, environment, binary input, exit status and retained output', async (): Promise<void> => {
    await using fixture: HostWorkspaceFixture = await HostWorkspaceFixture.create();
    const request: HostProcessRequest = {
        ...command(
            "process.stdin.on('data', b => process.stdout.write(b)); process.stdin.on('end', () => { process.stderr.write(process.env.NERVA_HOST_TEST); process.exitCode = 7; });",
        ),
        environment: { NERVA_HOST_TEST: 'value with spaces' },
    };
    const started: HostProcessSnapshot = await fixture.host.start(request);
    await fixture.host.input(started.processId, Buffer.from([0, 1, 255, 10]), true);
    const result: HostProcessSnapshot = await finished(fixture.host, started.processId);
    expect(result.exitCode).toBe(7);
    expect(result.failure).toBeNull();
    expect(result.stdout.bytes).toEqual(Buffer.from([0, 1, 255, 10]));
    expect(result.stderr.bytes.toString()).toBe('value with spaces');
    fixture.allowed = false;
    await expect(fixture.host.output(started.processId, 0n, 0n, 100)).rejects.toThrow('revoked');
    fixture.allowed = true;
    expect((await fixture.host.output(started.processId, 2n, 0n, 100)).stdout.bytes).toEqual(
        Buffer.from([255, 10]),
    );
    await fixture.host.release(started.processId);
    await expect(fixture.host.output(started.processId, 0n, 0n, 100)).rejects.toThrow(
        'unavailable',
    );
    const cwd: HostProcessSnapshot = await fixture.host.start(
        command('process.stdout.write(process.cwd())'),
    );
    expect((await finished(fixture.host, cwd.processId)).stdout.bytes.toString()).toBe(
        fixture.directory,
    );
});

it.skipIf(process.platform === 'win32')(
    'bash commands can use host programs and working-directory files',
    async (): Promise<void> => {
        await using fixture: HostWorkspaceFixture = await HostWorkspaceFixture.create();
        await writeFile(join(fixture.directory, 'input.txt'), 'first\nneedle\nlast\n');
        const started: HostProcessSnapshot = await fixture.host.start({
            executable: null,
            arguments: [],
            shell: ConnectorHostShell.Bash,
            command: 'cat input.txt | grep needle; tail -n 1 input.txt',
            directory: null,
            environment: {},
            timeoutMs: 10000,
        });
        const result: HostProcessSnapshot = await finished(fixture.host, started.processId);
        expect(result.exitCode).toBe(0);
        expect(result.stdout.bytes.toString()).toBe('needle\nlast\n');
    },
);

it('timeout, launch failure and explicit stop retain distinct effectful outcomes', async (): Promise<void> => {
    await using fixture: HostWorkspaceFixture = await HostWorkspaceFixture.create();
    const timed: HostProcessSnapshot = await fixture.host.start(
        command('setInterval(() => {}, 1000)', 100),
    );
    expect((await finished(fixture.host, timed.processId)).failure).toBe(
        HostProcessFailure.Timeout,
    );
    const missing: HostProcessSnapshot = await fixture.host.start({
        ...command(''),
        executable: join(fixture.directory, 'missing-program'),
    });
    expect((await finished(fixture.host, missing.processId)).failure).toBe(
        HostProcessFailure.Launch,
    );
    const stopped: HostProcessSnapshot = await fixture.host.start(
        command('setInterval(() => {}, 1000)'),
    );
    await fixture.host.stop(stopped.processId);
    expect((await fixture.host.output(stopped.processId, 0n, 0n, 10)).failure).toBe(
        HostProcessFailure.Cancelled,
    );
});

it('byte rings keep exact loss offsets and bounded newest binary output', (): void => {
    const ring: HostByteRing = new HostByteRing();
    ring.append(Buffer.alloc(HostWorkspaceLimits.streamBytes - 2, 1));
    ring.append(Buffer.from([2, 3, 4, 5]));
    expect(ring.read(0n, 3)).toMatchObject({
        offset: 2n,
        nextOffset: 5n,
        endOffset: BigInt(HostWorkspaceLimits.streamBytes + 2),
        truncated: true,
    });
    const end: bigint = BigInt(HostWorkspaceLimits.streamBytes + 2);
    expect(ring.read(end - 4n, 4).bytes).toEqual(Buffer.from([2, 3, 4, 5]));
    ring.append(Buffer.alloc(HostWorkspaceLimits.streamBytes + 4, 9));
    expect(ring.read(0n, 8).bytes).toEqual(Buffer.alloc(8, 9));
    expect((): void => {
        ring.read(-1n, 1);
    }).toThrow();
});

it('byte rings grow with received output and stay exact across growth and wrap', (): void => {
    const ring: HostByteRing = new HostByteRing();
    const chunks: Buffer[] = [];
    for (let index: number = 0; index < 400; index++) {
        const chunk: Buffer = Buffer.alloc(3001 + index, index % 251);
        chunks.push(chunk);
        ring.append(chunk);
    }
    const all: Buffer = Buffer.concat(chunks);
    expect(ring.read(0n, all.length)).toMatchObject({
        offset: 0n,
        endOffset: BigInt(all.length),
        truncated: false,
    });
    expect(ring.read(0n, all.length).bytes.equals(all)).toBe(true);
    const overflow: Buffer = Buffer.alloc(HostWorkspaceLimits.streamBytes, 7);
    ring.append(overflow);
    ring.append(Buffer.from([1, 2, 3]));
    const end: bigint = BigInt(all.length + overflow.length + 3);
    expect(ring.read(0n, 4)).toMatchObject({
        offset: end - BigInt(HostWorkspaceLimits.streamBytes),
        truncated: true,
    });
    expect(ring.read(end - 5n, 5).bytes).toEqual(Buffer.from([7, 7, 1, 2, 3]));
    expect(ring.read(end, 5).bytes).toHaveLength(0);
});

it('a retained ring holds about what it received rather than the whole stream bound', (): void => {
    const before: number = process.memoryUsage().arrayBuffers;
    const rings: HostByteRing[] = [];
    for (let index: number = 0; index < 64; index++) {
        const ring: HostByteRing = new HostByteRing();
        ring.append(Buffer.from('dir\r\n'));
        rings.push(ring);
    }
    const grown: number = process.memoryUsage().arrayBuffers - before;
    expect(rings).toHaveLength(64);
    expect(grown).toBeLessThan((64 * HostWorkspaceLimits.streamBytes) / 16);
});

it.skipIf(process.platform !== 'linux')(
    'release kills ordinary background descendants after the original executable exits',
    async (): Promise<void> => {
        await using fixture: HostWorkspaceFixture = await HostWorkspaceFixture.create();
        const started: HostProcessSnapshot = await fixture.host.start(
            command(
                "const c = require('node:child_process').spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { stdio: 'ignore' }); process.stdout.write(String(c.pid)); c.unref();",
            ),
        );
        const result: HostProcessSnapshot = await finished(fixture.host, started.processId);
        const pid: number = Number(result.stdout.bytes.toString());
        expect(Number.isSafeInteger(pid)).toBe(true);
        expect(pid).toBeGreaterThan(1);
        expect((): void => {
            process.kill(pid, 0);
        }).not.toThrow();
        await fixture.host.release(started.processId);
        let live: boolean = true;
        for (let attempt: number = 0; attempt < 100 && live; attempt += 1) {
            try {
                const status: string = await readFile('/proc/' + pid.toString() + '/stat', 'utf8');
                live = !/\) Z /u.test(status);
            } catch {
                live = false;
            }
            if (live) {
                await setTimeout(20);
            }
        }
        expect(live).toBe(false);
    },
);

it('disposal interrupts a blocked stdin write instead of waiting for the program lifetime', async (): Promise<void> => {
    await using fixture: HostWorkspaceFixture = await HostWorkspaceFixture.create();
    const started: HostProcessSnapshot = await fixture.host.start(
        command('setInterval(() => {}, 1000)', 60000),
    );
    const input: Promise<PromiseSettledResult<void>[]> = Promise.allSettled([
        fixture.host.input(
            started.processId,
            Buffer.alloc(HostWorkspaceLimits.chunkBytes, 1),
            false,
        ),
    ]);
    await setTimeout(30);
    await fixture.host[Symbol.asyncDispose]();
    expect((await input)[0].status).toBe('rejected');
    await expect(fixture.host.stat('.')).rejects.toThrow('closed');
});

it('a blocked stdin write has a finite deadline and retains timeout uncertainty', async (): Promise<void> => {
    await using fixture: HostWorkspaceFixture = await HostWorkspaceFixture.create();
    const started: HostProcessSnapshot = await fixture.host.start(
        command('setInterval(() => {}, 1000)', 60000),
    );
    await expect(
        fixture.host.input(
            started.processId,
            Buffer.alloc(HostWorkspaceLimits.chunkBytes, 1),
            false,
        ),
    ).rejects.toThrow('some bytes may have been delivered');
    const result: HostProcessSnapshot = await fixture.host.output(started.processId, 0n, 0n, 10);
    expect(result.running).toBe(false);
    expect(result.failure).toBe(HostProcessFailure.Timeout);
}, 15000);

it('closing while authorization is pending prevents late filesystem effects', async (): Promise<void> => {
    await using fixture: HostWorkspaceFixture = await HostWorkspaceFixture.create();
    const ready: PromiseWithResolvers<undefined> = Promise.withResolvers<undefined>();
    const admitted: PromiseWithResolvers<undefined> = Promise.withResolvers<undefined>();
    const authorization: HostWorkspaceAuthorization = {
        authorize: async (_access: HostWorkspaceAccess): Promise<void> => {
            admitted.resolve(undefined);
            await ready.promise;
        },
    };
    const workspace: HostWorkspace = await HostWorkspace.create({
        directory: fixture.directory,
        authorization,
    });
    const write: Promise<PromiseSettledResult<bigint>[]> = Promise.allSettled([
        workspace.write('late-file.txt', Buffer.from('late'), ConnectorHostWriteMode.Create, 0n),
    ]);
    await admitted.promise;
    const disposal: Promise<void> = workspace[Symbol.asyncDispose]();
    ready.resolve(undefined);
    await disposal;
    expect((await write)[0].status).toBe('rejected');
    await expect(stat(join(fixture.directory, 'late-file.txt'))).rejects.toThrow();
});
