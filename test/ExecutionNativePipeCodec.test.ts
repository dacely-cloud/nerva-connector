// SPDX-FileCopyrightText: 2026 Nerva contributors
// SPDX-License-Identifier: LicenseRef-Proprietary

import { createHash } from 'node:crypto';
import { Duplex, PassThrough, Readable, Writable } from 'node:stream';
import { expect, it } from 'vitest';
import { ExecutionMachineBoundary as Data } from 'nerva-connector-protocol/execution/ExecutionMachineBoundary.js';
import { ExecutionNativePipeCodec as Codec } from '../src/execution/ExecutionNativePipeCodec.js';
import { ExecutionNativePipeHandle } from '../src/execution/ExecutionNativePipeHandle.js';
import {
    ExecutionNativePipeCommandKind,
    type ExecutionNativePipeData,
} from '../src/execution/ExecutionNativePipeProtocol.js';

function data(bytes: Buffer = Buffer.from('a\0b')): ExecutionNativePipeData {
    return {
        kind: ExecutionNativePipeCommandKind.Data,
        incarnation: 'a'.repeat(64),
        inputSequence: 0n,
        offset: 0n,
        deliveryExpiresAtMs: 9223372036854775807n,
        inputHash: 'b'.repeat(64),
        dataHash: createHash('sha256').update(bytes).digest('hex'),
        byteLength: BigInt(bytes.byteLength),
        dataBase64: bytes.toString('base64'),
    };
}

it('native control encoding detaches exact binary data and rejects accessor discriminants without invoking them', (): void => {
    const original: ExecutionNativePipeData = data();
    const raw: unknown = JSON.parse(Codec.encode(original));
    expect(Codec.command(raw)).toEqual(original);
    let calls: number = 0;
    Object.defineProperty(original, 'kind', {
        get: (): string => {
            calls++;
            return 'data';
        },
    });
    expect((): string => Codec.encode(original)).toThrow();
    expect(
        ():
            | ExecutionNativePipeData
            | import('../src/execution/ExecutionNativePipeProtocol.js').ExecutionNativePipeEnd =>
            Codec.command(original),
    ).toThrow();
    expect(calls).toBe(0);
});

it('native data and EOF have closed variants, canonical exact quantities and independent finite byte bounds', (): void => {
    const raw: unknown = JSON.parse(Codec.encode(data()));
    if (typeof raw !== 'object' || raw === null) {
        throw new Error('Decoded native test command required');
    }
    for (const changed of [
        { ...raw, offset: '01' },
        { ...raw, inputSequence: '256' },
        { ...raw, offset: '65536' },
        { ...raw, dataHash: 'c'.repeat(64) },
        { ...raw, dataBase64: 'YR==' },
        { ...raw, byteLength: '4' },
        { ...raw, extra: true },
        { ...raw, kind: 'resize' },
        { ...raw, dataBase64: Buffer.alloc(4097).toString('base64') },
    ]) {
        expect((): ReturnType<typeof Codec.command> => Codec.command(changed)).toThrow();
    }
    expect((): ReturnType<typeof Codec.command> =>
        Codec.command({
            kind: 'end',
            incarnation: 'a'.repeat(64),
            inputSequence: '0',
            offset: '0',
            inputHash: 'b'.repeat(64),
        }),
    ).toThrow();
    const empty: ExecutionNativePipeData = data(Buffer.alloc(0));
    expect(Codec.command(JSON.parse(Codec.encode(empty)))).toEqual(empty);
    expect((): string => Codec.encode({ ...empty, inputSequence: 1n })).toThrow();
});

/** A paired local stream seam tests protocol ownership only; it supplies no native exec or cryptographic evidence. */
class NativePipePeer implements Disposable {
    public readonly input: PassThrough = new PassThrough();
    public readonly output: PassThrough = new PassThrough();
    readonly #channel: Duplex = Duplex.from({
        readable: Readable.toWeb(this.output),
        writable: Writable.toWeb(this.input),
    });
    public readonly handle: ExecutionNativePipeHandle = new ExecutionNativePipeHandle(
        'a'.repeat(64),
        'a\0b',
        { maximumInputBytes: 65536n, maximumControls: 256 },
        9223372036854775807n,
    );
    public faults: number = 0;
    public written: string = '';
    public constructor() {
        this.input.on('data', (chunk: Buffer): void => {
            this.written += chunk.toString('utf8');
        });
        this.handle.attach(
            this.#channel,
            (): void => {
                this.faults++;
            },
            (): void => {},
        );
    }
    public ready(): void {
        this.output.write(
            JSON.stringify({
                kind: 'ready',
                incarnation: 'a'.repeat(64),
                initialInputBytes: 3,
                initialInputHash: createHash('sha256').update('a\0b').digest('hex'),
            }) + '\n',
        );
    }
    public receipt(inputHash: string = 'b'.repeat(64)): void {
        this.output.write(
            JSON.stringify({
                kind: 'applied',
                incarnation: 'a'.repeat(64),
                inputSequence: '0',
                inputHash,
                acceptedOffset: '3',
                ended: false,
            }) + '\n',
        );
    }
    public [Symbol.dispose](): void {
        this.handle.close();
        this.#channel.destroy();
        this.input.destroy();
        this.output.destroy();
    }
}

it('a borrowed native handle retains one exact input until its matched receipt and returns an exact duplicate without another write', async (): Promise<void> => {
    using peer: NativePipePeer = new NativePipePeer();
    peer.ready();
    await peer.handle.ready;
    const original: ExecutionNativePipeData = data();
    const first: ReturnType<ExecutionNativePipeHandle['send']> = peer.handle.send(original);
    const duplicate: ReturnType<ExecutionNativePipeHandle['send']> = peer.handle.send(original);
    await expect(peer.handle.send({ ...original, inputHash: 'c'.repeat(64) })).rejects.toThrow(
        'in flight',
    );
    peer.receipt();
    const receipt: Awaited<ReturnType<ExecutionNativePipeHandle['send']>> = await first;
    expect(await duplicate).toEqual(receipt);
    const before: string = peer.written;
    expect(await peer.handle.send(original)).toEqual(receipt);
    expect(peer.written).toBe(before);
    expect(peer.written.split('\n').filter(Boolean)).toHaveLength(1);
    expect(peer.handle.cursor()).toMatchObject({
        processedSequence: 0n,
        acceptedOffset: 3n,
        initialAccepted: true,
    });
});

it('a substituted native receipt poisons only that owner without advancing any confirmed input range', async (): Promise<void> => {
    using peer: NativePipePeer = new NativePipePeer();
    peer.ready();
    await peer.handle.ready;
    const pending: ReturnType<ExecutionNativePipeHandle['send']> = peer.handle.send(data());
    const rejection: Promise<void> = expect(pending).rejects.toThrow('unconfirmed');
    peer.receipt('c'.repeat(64));
    await rejection;
    expect(peer.faults).toBe(1);
    expect(peer.handle.cursor()).toMatchObject({
        processedSequence: null,
        acceptedOffset: 0n,
        initialAccepted: false,
    });
    await expect(peer.handle.send(data())).rejects.toThrow('unavailable');
});

it('native delivery cutoffs are mandatory exact positive int64 values and only the wrapper expiry is excluded from stable input equality', (): void => {
    const first: ExecutionNativePipeData = data(Buffer.alloc(4096, 255));
    const raw: unknown = JSON.parse(Codec.encode(first));
    const wire: Readonly<Record<string, unknown>> = Data.record(raw, [
        'kind',
        'incarnation',
        'inputSequence',
        'offset',
        'inputHash',
        'deliveryExpiresAtMs',
        'dataHash',
        'byteLength',
        'dataBase64',
    ]);
    for (const value of [undefined, null, 0, '0', '01', '-1', '1.0', '9223372036854775808']) {
        expect((): ReturnType<typeof Codec.command> =>
            Codec.command({ ...wire, deliveryExpiresAtMs: value }),
        ).toThrow();
    }
    expect(Codec.capture(first).identity).toBe(
        Codec.capture({ ...first, deliveryExpiresAtMs: 1n }).identity,
    );
    const changed: Buffer = Buffer.alloc(4096, 254);
    expect(Codec.capture(first).identity).not.toBe(
        Codec.capture({
            ...first,
            dataBase64: changed.toString('base64'),
            dataHash: createHash('sha256').update(changed).digest('hex'),
        }).identity,
    );
    const commandBytes: number = Buffer.byteLength(
        Codec.encode({ ...first, inputSequence: 255n, offset: 61440n }),
    );
    expect(commandBytes).toBeLessThanOrEqual(8192);
    const expiredBytes: number = Buffer.byteLength(
        JSON.stringify({
            kind: 'expired',
            incarnation: first.incarnation,
            inputSequence: '255',
            inputHash: first.inputHash,
            confirmedOffset: '65536',
        }) + '\n',
    );
    expect(expiredBytes).toBeLessThanOrEqual(1024);
    console.info(
        JSON.stringify({
            maximumNativeCommandBytes: commandBytes,
            maximumNativeExpiredBytes: expiredBytes,
        }),
    );
});

it('a renewed native wrapper joins the original pending delivery and returns the same completed proof with no second write', async (): Promise<void> => {
    using peer: NativePipePeer = new NativePipePeer();
    peer.ready();
    await peer.handle.ready;
    const original: ExecutionNativePipeData = data();
    const first: ReturnType<ExecutionNativePipeHandle['send']> = peer.handle.send(original);
    const renewed: ReturnType<ExecutionNativePipeHandle['send']> = peer.handle.send({
        ...original,
        deliveryExpiresAtMs: 1n,
    });
    peer.receipt();
    const result: Awaited<ReturnType<ExecutionNativePipeHandle['send']>> = await first;
    expect(await renewed).toBe(result);
    const before: string = peer.written;
    expect(await peer.handle.send({ ...original, deliveryExpiresAtMs: 2n })).toBe(result);
    expect(peer.written).toBe(before);
    expect(peer.written.split('\n').filter(Boolean)).toHaveLength(1);
});

it('an exact native Expired negative event preserves the prior fully confirmed cursor and cannot claim EOF or positive acceptance', async (): Promise<void> => {
    using peer: NativePipePeer = new NativePipePeer();
    peer.ready();
    await peer.handle.ready;
    const pending: ReturnType<ExecutionNativePipeHandle['send']> = peer.handle.send(data());
    const rejected: Promise<void> = expect(pending).rejects.toThrow('unconfirmed');
    peer.output.write(
        JSON.stringify({
            kind: 'expired',
            incarnation: 'a'.repeat(64),
            inputSequence: '0',
            inputHash: 'b'.repeat(64),
            confirmedOffset: '0',
        }) + '\n',
    );
    await rejected;
    expect(peer.handle.cursor()).toEqual({
        processedSequence: null,
        processedInputHash: null,
        acceptedOffset: 0n,
        initialAccepted: false,
        ended: false,
    });
    expect(peer.faults).toBe(1);
    await expect(peer.handle.send(data())).rejects.toThrow('unavailable');
});
