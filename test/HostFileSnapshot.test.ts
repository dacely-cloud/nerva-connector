// SPDX-FileCopyrightText: 2026 Nerva contributors
// SPDX-License-Identifier: LicenseRef-Proprietary

import { createHash } from 'node:crypto';
import { writeFile, open, readdir, readlink, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { setTimeout } from 'node:timers/promises';
import { expect, it } from 'vitest';
import { ConnectorHostErrorCode } from 'nerva-connector-protocol/protocol/ConnectorHost.js';
import { HostMcpWorkspaceTools } from '../src/host/HostMcpWorkspaceTools.js';
import { HostFileSnapshotCodec } from '../src/host/HostFileSnapshotCodec.js';
import type {
    HostFileSnapshot,
    HostFileDigestResult,
    HostFileRead,
} from '../src/host/HostWorkspaceTypes.js';
import { HostWorkspaceFixture } from './support/HostWorkspaceFixture.js';

/** Metadata is captured by the same native API the remote consumer uses. */
async function snapshot(fixture: HostWorkspaceFixture, path: string): Promise<HostFileSnapshot> {
    const value: Awaited<ReturnType<typeof fixture.host.stat>> = await fixture.host.stat(
        path,
        true,
    );
    return { identity: value.identity, size: value.size, modifiedAtNs: value.modifiedAtNs };
}

/** A sparse file exercises streaming and cancellation without allocating a file-sized buffer or writing data copies. */
async function sparse(path: string): Promise<void> {
    const file: Awaited<ReturnType<typeof open>> = await open(path, 'wx', 0o600);
    try {
        await file.truncate(256 * 1024 * 1024);
    } finally {
        await file.close();
    }
}

/** Observe an actual live descriptor's advancing file position before changing or cancelling its owner. */
async function advancing(path: string): Promise<string> {
    for (let attempt: number = 0; attempt < 200; attempt += 1) {
        const descriptors: readonly string[] = await readdir('/proc/self/fd');
        const matches: readonly (string | null)[] = await Promise.all(
            descriptors.map(async (descriptor: string): Promise<string | null> => {
                try {
                    if ((await readlink('/proc/self/fd/' + descriptor)) !== path) {
                        return null;
                    }
                    const info: string = await readFile('/proc/self/fdinfo/' + descriptor, 'utf8');
                    const position: RegExpExecArray | null = /^pos:\s+([0-9]+)$/mu.exec(info);
                    return position !== null && BigInt(position[1]) > 0n ? descriptor : null;
                } catch {
                    return null;
                }
            }),
        );
        const match: string | null | undefined = matches.find(
            (entry: string | null): boolean => entry !== null,
        );
        if (match !== null && match !== undefined) {
            return match;
        }
        await setTimeout(1);
    }
    throw new Error('Original file digest did not expose a live advancing descriptor');
}

it('snapshot reads preserve existing fields and complete digests match exact bytes of the opened generation', async (): Promise<void> => {
    await using fixture: HostWorkspaceFixture = await HostWorkspaceFixture.create();
    const path: string = join(fixture.directory, 'bytes.bin');
    const bytes: Buffer = Buffer.alloc(3 * 1024 * 1024 + 19, 0xa7);
    await writeFile(path, bytes);
    const captured: HostFileSnapshot = await snapshot(fixture, path);
    const chunk: HostFileRead = await fixture.host.read(path, 17n, 32768, captured);
    expect(chunk).toMatchObject({
        offset: 17n,
        nextOffset: 32785n,
        size: BigInt(bytes.length),
        eof: false,
    });
    expect(chunk.bytes).toEqual(bytes.subarray(17, 32785));
    expect(await fixture.host.digest(path, captured)).toEqual({
        algorithm: 'sha256',
        digest: createHash('sha256').update(bytes).digest('hex'),
        ...captured,
    });
    const tools: HostMcpWorkspaceTools = new HostMcpWorkspaceTools(
        fixture.host,
        new AbortController().signal,
    );
    const wire: string = await tools.call('file_digest', {
        path,
        snapshot: {
            identity: captured.identity,
            size: captured.size.toString(),
            modifiedAtNs: captured.modifiedAtNs.toString(),
        },
    });
    const result: unknown = JSON.parse(wire);
    expect(result).toEqual({
        algorithm: 'sha256',
        digest: createHash('sha256').update(bytes).digest('hex'),
        identity: captured.identity,
        size: captured.size.toString(),
        modifiedAtNs: captured.modifiedAtNs.toString(),
    });
    await writeFile(path, Buffer.alloc(bytes.length, 0xb8));
    await expect(fixture.host.read(path, 0n, 32768, captured)).rejects.toMatchObject({
        code: ConnectorHostErrorCode.SnapshotChanged,
        definitive: true,
    });
    await expect(fixture.host.digest(path, captured)).rejects.toThrow('snapshot changed');
});

it('empty-file hashing is complete and snapshot JSON quantities preserve precision and signed timestamps', async (): Promise<void> => {
    await using fixture: HostWorkspaceFixture = await HostWorkspaceFixture.create();
    const path: string = join(fixture.directory, 'empty.bin');
    await writeFile(path, '');
    const captured: HostFileSnapshot = await snapshot(fixture, path);
    expect((await fixture.host.digest(path, captured)).digest).toBe(
        createHash('sha256').digest('hex'),
    );
    expect(
        HostFileSnapshotCodec.decode({
            identity: 'opaque',
            size: '9007199254740993',
            modifiedAtNs: '-1000000000',
        }),
    ).toEqual({ identity: 'opaque', size: 9007199254740993n, modifiedAtNs: -1000000000n });
    for (const value of [
        { identity: '', size: '1', modifiedAtNs: '1' },
        { identity: 'opaque', size: 1, modifiedAtNs: '1' },
        { identity: 'opaque', size: '1', modifiedAtNs: '-0' },
    ]) {
        expect((): void => {
            HostFileSnapshotCodec.decode(value);
        }).toThrow();
    }
});

it.skipIf(process.platform !== 'linux')(
    'an in-progress descriptor digest rejects changed content instead of returning a mixed-generation hash',
    async (): Promise<void> => {
        await using fixture: HostWorkspaceFixture = await HostWorkspaceFixture.create();
        const path: string = join(fixture.directory, 'sparse.bin');
        await sparse(path);
        const captured: HostFileSnapshot = await snapshot(fixture, path);
        const outcome: Promise<PromiseSettledResult<HostFileDigestResult>[]> = Promise.allSettled([
            fixture.host.digest(path, captured),
        ]);
        await advancing(path);
        const writer: Awaited<ReturnType<typeof open>> = await open(path, 'r+');
        try {
            await writer.write(Buffer.from('changed'), 0, 7, 0);
        } finally {
            await writer.close();
        }
        const result: PromiseSettledResult<HostFileDigestResult> = (await outcome)[0];
        expect(result.status).toBe('rejected');
        if (result.status === 'rejected') {
            expect(String(result.reason)).toContain('snapshot changed');
        }
    },
);

it.skipIf(process.platform !== 'linux')(
    'cancelling an active streamed digest joins its read and releases the actual descriptor',
    async (): Promise<void> => {
        await using fixture: HostWorkspaceFixture = await HostWorkspaceFixture.create();
        const path: string = join(fixture.directory, 'cancel.bin');
        await sparse(path);
        const captured: HostFileSnapshot = await snapshot(fixture, path);
        const stop: AbortController = new AbortController();
        const outcome: Promise<PromiseSettledResult<HostFileDigestResult>[]> = Promise.allSettled([
            fixture.host.digest(path, captured, stop.signal),
        ]);
        const descriptor: string = await advancing(path);
        stop.abort(new Error('Digest cancelled by test owner'));
        const result: PromiseSettledResult<HostFileDigestResult> = (await outcome)[0];
        expect(result.status).toBe('rejected');
        if (result.status === 'rejected') {
            expect(String(result.reason)).toContain('cancelled by test owner');
        }
        let retained: string | null = null;
        try {
            retained = await readlink('/proc/self/fd/' + descriptor);
        } catch {
            retained = null;
        }
        expect(retained).not.toBe(path);
    },
);

it.skipIf(process.platform !== 'linux')(
    'digest admission bounds concurrent buffers and workspace close joins active descriptor cleanup',
    async (): Promise<void> => {
        await using fixture: HostWorkspaceFixture = await HostWorkspaceFixture.create();
        const path: string = join(fixture.directory, 'bounded.bin');
        await sparse(path);
        const captured: HostFileSnapshot = await snapshot(fixture, path);
        const outcomes: Promise<PromiseSettledResult<HostFileDigestResult>[]> = Promise.allSettled([
            fixture.host.digest(path, captured),
            fixture.host.digest(path, captured),
            fixture.host.digest(path, captured),
        ]);
        const descriptor: string = await advancing(path);
        await fixture.host[Symbol.asyncDispose]();
        const results: readonly PromiseSettledResult<HostFileDigestResult>[] = await outcomes;
        expect(
            results.every(
                (result: PromiseSettledResult<HostFileDigestResult>): boolean =>
                    result.status === 'rejected',
            ),
        ).toBe(true);
        expect(
            results.filter(
                (result: PromiseSettledResult<HostFileDigestResult>): boolean =>
                    result.status === 'rejected' &&
                    String(result.reason).includes('digest limit reached'),
            ),
        ).toHaveLength(1);
        let retained: string | null = null;
        try {
            retained = await readlink('/proc/self/fd/' + descriptor);
        } catch {
            retained = null;
        }
        expect(retained).not.toBe(path);
    },
);

it('exclusive creation rejects a known existing file before any write with a definitive bounded code', async (): Promise<void> => {
    await using fixture: HostWorkspaceFixture = await HostWorkspaceFixture.create();
    const path: string = join(fixture.directory, 'existing.bin');
    await writeFile(path, 'preserved bytes');
    await expect(
        fixture.host.write(path, Buffer.from('refused'), 'create', 0n),
    ).rejects.toMatchObject({ code: ConnectorHostErrorCode.AlreadyExists, definitive: true });
    expect(await readFile(path, 'utf8')).toBe('preserved bytes');
});
