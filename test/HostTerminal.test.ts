// SPDX-FileCopyrightText: 2026 Nerva contributors
// SPDX-License-Identifier: LicenseRef-Proprietary

import { existsSync } from 'node:fs';
import { duplexPair, type Duplex } from 'node:stream';
import { setTimeout as delay } from 'node:timers/promises';
import { afterEach, expect, it, vi, type MockInstance } from 'vitest';
import { HostTerminal } from '../src/host/HostTerminal.js';
import { HostTerminalChannel } from '../src/host/HostTerminalChannel.js';
import {
    HostTerminalBackend,
    type HostTerminalBackendObserver,
} from '../src/host/HostTerminalBackend.js';
import { HostTerminalStopProof } from '../src/host/HostTerminalStopProof.js';
import {
    HostTerminalReportCodec,
    HostTerminalReportKind,
    type HostTerminalReport,
    type HostTerminalStateReport,
} from '../src/host/HostTerminalReport.js';
import {
    HostTerminalControlKind,
    type HostTerminalRequest,
    type HostTerminalSnapshot,
    type HostTerminalControl,
} from '../src/host/HostTerminalTypes.js';
import { HostLinuxBuild } from '../src/host/HostLinuxBuild.js';
import { Boundary } from 'nerva-connector-protocol/protocol/Boundary.js';

afterEach((): void => {
    vi.restoreAllMocks();
});

it('Windows shutdown proof requires actual Job-zero evidence while POSIX preserves unknown tree state', (): void => {
    const state: HostTerminalStateReport = {
        kind: HostTerminalReportKind.State,
        running: false,
        treeRunning: null,
        exitCode: 0,
        signal: null,
        outputComplete: true,
        outputFinalBytes: 0n,
    };
    expect(HostTerminalStopProof.known(state, 'linux')).toBe(true);
    expect(HostTerminalStopProof.known(state, 'win32')).toBe(false);
    expect(HostTerminalStopProof.known({ ...state, treeRunning: true }, 'win32')).toBe(false);
    expect(HostTerminalStopProof.known({ ...state, treeRunning: false }, 'win32')).toBe(true);
    expect(
        HostTerminalStopProof.known(
            { ...state, treeRunning: false, outputComplete: false, outputFinalBytes: null },
            'win32',
        ),
    ).toBe(false);
});

it.each([null, true])(
    'an ok native stop ACK cannot release the driver while Windows tree evidence is %s',
    async (treeRunning: boolean | null): Promise<void> => {
        const known: typeof HostTerminalStopProof.known =
            HostTerminalStopProof.known.bind(HostTerminalStopProof);
        vi.spyOn(HostTerminalStopProof, 'known').mockImplementation(
            (state: HostTerminalStateReport | null): boolean => known(state, 'win32'),
        );
        let observed: HostTerminalBackendObserver | null = null;
        const state: HostTerminalStateReport = {
            kind: HostTerminalReportKind.State,
            running: false,
            treeRunning,
            exitCode: 0,
            signal: null,
            outputComplete: true,
            outputFinalBytes: 0n,
        };
        vi.spyOn(HostTerminalBackend.prototype, 'start').mockImplementation(function (
            this: HostTerminalBackend,
        ): Promise<void> {
            observed = this.observer;
            this.observer.report({ kind: HostTerminalReportKind.Ready, cols: 80, rows: 24 }, null);
            this.observer.report(state, null);
            return Promise.resolve();
        });
        vi.spyOn(HostTerminalBackend.prototype, 'spawned', 'get').mockReturnValue(true);
        vi.spyOn(HostTerminalBackend.prototype, 'ended', 'get').mockReturnValue(false);
        vi.spyOn(HostTerminalBackend.prototype, 'closed', 'get').mockReturnValue(Promise.resolve());
        vi.spyOn(HostTerminalBackend.prototype, 'control').mockImplementation(function (
            this: HostTerminalBackend,
        ): Promise<void> {
            const control: HostTerminalControl = {
                operation: HostTerminalControlKind.Stop,
                id: 1n,
                cols: null,
                rows: null,
            };
            this.observer.report(
                { kind: HostTerminalReportKind.Control, id: 1n, ok: true },
                control,
            );
            return Promise.resolve();
        });
        const close: MockInstance<HostTerminalBackend['closeControl']> = vi
            .spyOn(HostTerminalBackend.prototype, 'closeControl')
            .mockResolvedValue();
        await using terminal: HostTerminal = await HostTerminal.create(
            'terminal-tree-proof',
            request('pass'),
            process.cwd(),
        );
        await expect(terminal.stop()).rejects.toThrow('shutdown evidence');
        expect(close).not.toHaveBeenCalled();
        if (observed === null) {
            throw new Error('Native terminal boundary was not captured');
        }
        const observer: HostTerminalBackendObserver = observed;
        observer.report({ ...state, treeRunning: false }, null);
        await terminal.stop();
        expect(close).toHaveBeenCalledOnce();
    },
);

/** Tests use real installed Python exclusively as a fixture application, without scripts or bytecode on disk. */
function request(source: string): HostTerminalRequest {
    return {
        executable: '/usr/bin/python3',
        arguments: ['-I', '-B', '-c', source],
        shell: null,
        command: null,
        directory: null,
        environment: {},
        timeoutMs: 10000,
        cols: 80,
        rows: 24,
    };
}

/** Snapshot observation never changes the native process or restarts its original. */
async function observe(
    terminal: HostTerminal,
    selected: (snapshot: HostTerminalSnapshot) => boolean,
): Promise<HostTerminalSnapshot> {
    for (let attempt: number = 0; attempt < 1000; attempt += 1) {
        const snapshot: HostTerminalSnapshot = terminal.snapshot(0n, 1048576);
        if (selected(snapshot)) {
            return snapshot;
        }
        await delay(5);
    }
    throw new Error('Owned terminal observation timed out');
}

const native: boolean =
    process.platform === 'linux' &&
    existsSync(HostLinuxBuild.executable()) &&
    existsSync(new URL('../build/nerva-connector-exec.json', import.meta.url));

it.skipIf(!native)(
    'the production owner launches its pinned native FD and confirms binary input, resize and exact terminal completion',
    async (): Promise<void> => {
        expect(await HostTerminal.available()).toBe(true);
        let registered: HostTerminal | null = null;
        await using terminal: HostTerminal = await HostTerminal.create(
            'terminal-native',
            request(
                "import os,tty,fcntl,termios,struct\ntty.setraw(0)\nos.write(1,b'READY\\n')\nassert os.read(0,1)==b'R'\nr,c,_,_=struct.unpack('HHHH',fcntl.ioctl(0,termios.TIOCGWINSZ,b'\\0'*8))\nos.write(1,('SIZE:%d,%d\\n'%(c,r)).encode())\ndata=os.read(0,64)\nos.write(1,b'INPUT:'+data)\nos._exit(7)",
            ),
            process.cwd(),
            undefined,
            undefined,
            (owner: HostTerminal): void => {
                registered = owner;
            },
        );
        expect(registered).toBe(terminal);
        await observe(terminal, (snapshot: HostTerminalSnapshot): boolean =>
            snapshot.output.bytes.includes(Buffer.from('READY\n')),
        );
        await terminal.resize(112, 37);
        expect(terminal.snapshot(0n, 1).cols).toBe(112);
        expect(terminal.snapshot(0n, 1).rows).toBe(37);
        await terminal.input(Buffer.from('R'));
        await observe(terminal, (snapshot: HostTerminalSnapshot): boolean =>
            snapshot.output.bytes.includes(Buffer.from('SIZE:112,37\n')),
        );
        await terminal.input(Buffer.from([0, 255, 10]));
        const finished: HostTerminalSnapshot = await observe(
            terminal,
            (snapshot: HostTerminalSnapshot): boolean =>
                !snapshot.running && snapshot.outputComplete,
        );
        expect(finished.exitCode).toBe(7);
        expect(finished.treeRunning).toBeNull();
        expect(finished.output.bytes.subarray(-9)).toEqual(
            Buffer.concat([Buffer.from('INPUT:'), Buffer.from([0, 255, 10])]),
        );
        expect(finished.finalOutputBytes).toBe(finished.output.endOffset);
    },
);

it.skipIf(!native)(
    'continuously drained output retains the latest four MiB and explicitly marks older overwritten bytes',
    async (): Promise<void> => {
        await using terminal: HostTerminal = await HostTerminal.create(
            'terminal-ring',
            request(
                'import os,tty\ntty.setraw(0)\ndata=bytes(range(256))*20480\nwhile data:\n n=os.write(1,data);data=data[n:]\nos._exit(0)',
            ),
            process.cwd(),
        );
        const finished: HostTerminalSnapshot = await observe(
            terminal,
            (snapshot: HostTerminalSnapshot): boolean => snapshot.outputComplete,
        );
        expect(finished.finalOutputBytes).toBe(5n * 1048576n);
        expect(finished.output.truncated).toBe(true);
        expect(finished.output.offset).toBe(1048576n);
        const chunks: Buffer[] = [];
        for (let offset: bigint = finished.output.offset; offset < finished.output.endOffset;) {
            const snapshot: HostTerminalSnapshot = terminal.snapshot(offset, 1048576);
            expect(snapshot.output.truncated).toBe(false);
            chunks.push(snapshot.output.bytes);
            offset = snapshot.output.nextOffset;
        }
        const pattern: Buffer = Buffer.from(
            Array.from({ length: 256 }, (_value: unknown, index: number): number => index),
        );
        expect(
            Buffer.concat(chunks).equals(
                Buffer.concat(Array.from({ length: 16384 }, (): Buffer => pattern)),
            ),
        ).toBe(true);
    },
);

it.skipIf(!native)(
    'stop joins the native broker while retaining the same original terminal output',
    async (): Promise<void> => {
        await using terminal: HostTerminal = await HostTerminal.create(
            'terminal-stop',
            request("import os,time\nos.write(1,b'OWNED')\nwhile True:time.sleep(.1)"),
            process.cwd(),
        );
        await observe(terminal, (snapshot: HostTerminalSnapshot): boolean =>
            snapshot.output.bytes.includes(Buffer.from('OWNED')),
        );
        await terminal.stop();
        const stopped: HostTerminalSnapshot = terminal.snapshot(0n, 32768);
        expect(stopped.running).toBe(false);
        expect(stopped.outputComplete).toBe(true);
        expect(stopped.signal).toBe('SIGKILL');
        expect(stopped.output.bytes.toString()).toBe('OWNED');
        await expect(terminal.input(Buffer.from('new'))).rejects.toThrow('closed');
    },
);

it.skipIf(!native)(
    'failed pre-spawn verification still exposes its registered owner for joined cleanup',
    async (): Promise<void> => {
        vi.spyOn(HostLinuxBuild, 'read').mockResolvedValue({ bytes: 64, sha256: '0'.repeat(64) });
        let registered: HostTerminal | null = null;
        await expect(
            HostTerminal.create(
                'terminal-bad-pin',
                request('pass'),
                process.cwd(),
                undefined,
                undefined,
                (owner: HostTerminal): void => {
                    registered = owner;
                },
            ),
        ).rejects.toThrow();
        if (registered === null) {
            throw new Error('Startup owner was not registered');
        }
        const owner: HostTerminal = registered;
        await owner[Symbol.asyncDispose]();
    },
);

it.skipIf(!native)(
    'a lifetime shorter than native startup begins at readiness instead of cancelling creation',
    async (): Promise<void> => {
        const read: typeof HostLinuxBuild.read = HostLinuxBuild.read.bind(HostLinuxBuild);
        vi.spyOn(HostLinuxBuild, 'read').mockImplementation(
            async (): ReturnType<typeof HostLinuxBuild.read> => {
                await delay(150);
                return await read();
            },
        );
        const input: HostTerminalRequest = {
            ...request("import os,time\nos.write(1,b'ADMITTED')\nwhile True:time.sleep(.1)"),
            timeoutMs: 50,
        };
        await using terminal: HostTerminal = await HostTerminal.create(
            'terminal-short-lifetime',
            input,
            process.cwd(),
        );
        const stopped: HostTerminalSnapshot = await observe(
            terminal,
            (snapshot: HostTerminalSnapshot): boolean =>
                snapshot.failure === 'timeout' && snapshot.outputComplete,
        );
        expect(stopped.running).toBe(false);
    },
    10000,
);

it.skipIf(!native)(
    'timeout stops the original and declared retention expires only its exact joined owner',
    async (): Promise<void> => {
        const expired: PromiseWithResolvers<HostTerminal> = Promise.withResolvers<HostTerminal>();
        const input: HostTerminalRequest = {
            ...request("import os,time\nos.write(1,b'RETAINED')\nwhile True:time.sleep(.1)"),
            timeoutMs: 1000,
            retentionAfterTimeoutMs: 1000,
        };
        await using terminal: HostTerminal = await HostTerminal.create(
            'terminal-retention',
            input,
            process.cwd(),
            undefined,
            (owner: HostTerminal): void => expired.resolve(owner),
        );
        const stopped: HostTerminalSnapshot = await observe(
            terminal,
            (snapshot: HostTerminalSnapshot): boolean =>
                snapshot.failure === 'timeout' && snapshot.outputComplete,
        );
        expect(stopped.output.bytes.toString()).toBe('RETAINED');
        expect(stopped.running).toBe(false);
        expect(await expired.promise).toBe(terminal);
    },
    10000,
);

it('native report decoding preserves exact counters and rejects incomplete or contradictory terminal state', (): void => {
    const token: string = 'a'.repeat(64);
    expect(
        HostTerminalReportCodec.decode(
            { token, kind: 'input', acceptedBytes: '9007199254740993' },
            token,
        ),
    ).toEqual({ kind: 'input', acceptedBytes: 9007199254740993n });
    const state: Readonly<Record<string, string | boolean | number | null>> = {
        token,
        kind: 'state',
        running: false,
        treeRunning: null,
        exitCode: 7,
        signal: null,
        outputComplete: true,
        outputFinalBytes: '3',
    };
    expect(HostTerminalReportCodec.decode(state, token)).toMatchObject({ outputFinalBytes: 3n });
    for (const changed of [
        { ...state, outputFinalBytes: 3 },
        { ...state, outputComplete: false },
        { ...state, running: true },
        { ...state, signal: 'SIGKILL' },
        { ...state, treeRunning: false, running: true },
        { ...state, token: 'b'.repeat(64) },
        { ...state, extra: true },
    ]) {
        expect((): void => {
            HostTerminalReportCodec.decode(changed, token);
        }).toThrow();
    }
});

/** A real duplex pair exercises the production private channel without OS-specific pipe files. */
class TerminalChannelFixture implements AsyncDisposable {
    public readonly native: Duplex;
    public readonly channel: HostTerminalChannel;
    public readonly errors: Error[] = [];
    public readonly reports: HostTerminalReport[] = [];
    public readonly sent: Buffer[] = [];

    public constructor(windows: boolean = false) {
        const pair: [Duplex, Duplex] = duplexPair();
        this.native = pair[1];
        this.channel = new HostTerminalChannel(
            {
                report: (report: HostTerminalReport): void => {
                    this.reports.push(report);
                },
                failed: (error: Error): void => {
                    this.errors.push(error);
                },
            },
            windows,
        );
        this.channel.attach(pair[0]);
        this.native.on('data', (bytes: Buffer): void => {
            this.sent.push(bytes);
        });
        this.native.on('error', (): void => undefined);
    }
    public send(value: Readonly<Record<string, string | boolean | number | null>>): void {
        this.native.write(JSON.stringify({ token: this.channel.token, ...value }) + '\n');
    }
    public async turn(): Promise<void> {
        await delay(0);
    }
    public async [Symbol.asyncDispose](): Promise<void> {
        await this.channel[Symbol.asyncDispose]();
        this.native.destroy();
    }
}

it('Windows mutual authentication sends no start secret until a valid native hello proves the same token', async (): Promise<void> => {
    await using fixture: TerminalChannelFixture = new TerminalChannelFixture(true);
    await fixture.turn();
    expect(fixture.sent).toHaveLength(0);
    fixture.send({ kind: 'hello' });
    await fixture.turn();
    const raw: unknown = JSON.parse(Buffer.concat(fixture.sent).toString('utf8'));
    expect(Boundary.record(raw, ['token', 'operation'])).toEqual({
        token: fixture.channel.token,
        operation: 'start',
    });
    expect(fixture.errors).toHaveLength(0);
});

it('ordinary resize admission reserves the final bounded native control for cleanup', async (): Promise<void> => {
    await using fixture: TerminalChannelFixture = new TerminalChannelFixture();
    fixture.native.on('data', (bytes: Buffer): void => {
        const raw: unknown = JSON.parse(bytes.toString('utf8'));
        const value: Readonly<Record<string, unknown>> = Boundary.record(raw, [
            'token',
            'operation',
            'id',
            'cols',
            'rows',
        ]);
        if (typeof value['id'] !== 'string') {
            throw new Error('Control ID required');
        }
        fixture.send({ kind: 'control', id: value['id'], ok: true });
    });
    for (let index: number = 0; index < 4095; index += 1) {
        await fixture.channel.control(HostTerminalControlKind.Resize, 80, 24);
    }
    await expect(fixture.channel.control(HostTerminalControlKind.Resize, 81, 24)).rejects.toThrow(
        'admission',
    );
    await fixture.channel.control(HostTerminalControlKind.Stop);
    expect(fixture.errors).toHaveLength(0);
});

it('an unauthenticated Windows peer receives no controller token or start authority', async (): Promise<void> => {
    await using fixture: TerminalChannelFixture = new TerminalChannelFixture(true);
    fixture.send({ kind: 'hello', token: 'b'.repeat(64) });
    await fixture.turn();
    expect(fixture.sent).toHaveLength(0);
    expect(fixture.errors).toHaveLength(1);
});

it('a negative native stop acknowledgment rejects only that attempt and permits an explicit same-owner retry', async (): Promise<void> => {
    await using fixture: TerminalChannelFixture = new TerminalChannelFixture();
    const first: Promise<void> = fixture.channel.control(HostTerminalControlKind.Stop);
    const rejected: Promise<void> = expect(first).rejects.toThrow('did not complete');
    fixture.send({ kind: 'control', id: '1', ok: false });
    await rejected;
    const second: Promise<void> = fixture.channel.control(HostTerminalControlKind.Stop);
    fixture.send({ kind: 'control', id: '2', ok: true });
    await second;
    expect(fixture.errors).toHaveLength(0);
});
