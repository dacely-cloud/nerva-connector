// SPDX-FileCopyrightText: 2026 Nerva contributors
// SPDX-License-Identifier: LicenseRef-Proprietary

import { afterEach, expect, it, vi, type MockInstance } from 'vitest';
import { ConnectorConsoleApp } from '../src/cli/ConnectorConsoleApp.js';
import { ConnectorConsoleSourceKind } from '../src/cli/ConnectorConsoleLocation.js';
import {
    ConnectorConsoleCommand,
    ConnectorConsoleModel,
    ConnectorConsolePhase,
} from '../src/cli/ConnectorConsoleModel.js';
import { ConnectorCloudConfiguration } from '../src/runtime/ConnectorCloudConfiguration.js';
import { ConnectorConnectionLog } from '../src/runtime/ConnectorConnectionLog.js';
import { SystemInfo } from '../src/system/SystemInfo.js';
import { ConnectorSetupSession } from '../src/cli/ConnectorSetupSession.js';
import type { ConnectorPermissionQuestions } from '../src/cli/ConnectorPermissionPrompt.js';
import { WindowsStateError, WindowsStateFailure } from '../src/windows/WindowsStateProtocol.js';
import {
    GpuInventoryState,
    SystemPlatform,
    type SystemSpecification,
} from 'nerva-connector-protocol/system/SystemSpecification.js';

/** The terminal boundary captures frames without requiring or changing the test runner's terminal. */
interface ConsoleCapture {
    model: ConnectorConsoleModel | null;
    command: ((command: ConnectorConsoleCommand) => void) | null;
    frames: string[];
    prompts: number;
}
/** The mocked view retains only the production constructor's disposable ownership contract. */
interface ConsoleViewModule {
    readonly ConnectorConsole: new (
        model: ConnectorConsoleModel,
        command: (command: ConnectorConsoleCommand) => void,
    ) => Disposable;
}
const capture: ConsoleCapture = vi.hoisted((): ConsoleCapture => ({
    model: null,
    command: null,
    frames: [],
    prompts: 0,
}));
vi.mock('../src/cli/ConnectorConsole.js', (): ConsoleViewModule => ({
    ConnectorConsole: class implements Disposable {
        /** Captures only public display state; no device or account boundary is replaced. */
        public constructor(
            public readonly model: ConnectorConsoleModel,
            command: (command: ConnectorConsoleCommand) => void,
        ) {
            capture.model = model;
            capture.command = command;
            this.draw();
        }
        /** Snapshotting catches visible progress before any deliberately stalled operation completes. */
        public draw(): void {
            capture.frames.push(this.model.activity + '\n' + this.model.details.join('\n'));
        }
        /** Setup screens run in place; the count shows a screen was opened. */
        public async withPrompt<T>(operation: () => Promise<T>): Promise<T> {
            capture.prompts++;
            return await operation();
        }
        /** The test terminal owns no OS descriptors or input modes. */
        public [Symbol.dispose](): void {}
    },
}));
/** The mocked screen owner exposes only the cancellation signal the app passes through. */
interface PromptModule {
    readonly ConnectorPermissionPrompt: new (signal: AbortSignal) => Disposable;
}
vi.mock('../src/cli/ConnectorPermissionPrompt.js', (): PromptModule => ({
    ConnectorPermissionPrompt: class implements Disposable {
        /** No raw input mode or alternate screen is taken in tests. */
        public constructor(public readonly signal: AbortSignal) {}
        /** Nothing to restore. */
        public [Symbol.dispose](): void {}
    },
}));

afterEach((): void => {
    vi.restoreAllMocks();
    vi.useRealTimers();
    capture.model = null;
    capture.command = null;
    capture.frames = [];
    capture.prompts = 0;
});

it('keeps the first-run screen open on a Windows storage failure and retries the same local check', async (): Promise<void> => {
    const tty: readonly [PropertyDescriptor | undefined, PropertyDescriptor | undefined] = [
        Object.getOwnPropertyDescriptor(process.stdin, 'isTTY'),
        Object.getOwnPropertyDescriptor(process.stdout, 'isTTY'),
    ];
    Object.defineProperty(process.stdin, 'isTTY', { value: true, configurable: true });
    Object.defineProperty(process.stdout, 'isTTY', { value: true, configurable: true });
    const load: MockInstance<ConnectorSetupSession['load']> = vi
        .spyOn(ConnectorSetupSession.prototype, 'load')
        .mockRejectedValue(new WindowsStateError(WindowsStateFailure.Untrusted));
    const log: MockInstance<ConnectorConnectionLog['record']> = vi
        .spyOn(ConnectorConnectionLog.prototype, 'record')
        .mockImplementation((): void => {});
    const prepare: MockInstance<typeof ConnectorCloudConfiguration.prepare> = vi.spyOn(
        ConnectorCloudConfiguration,
        'prepare',
    );
    const stop: AbortController = new AbortController();
    const running: Promise<void> = new ConnectorConsoleApp({
        kind: ConnectorConsoleSourceKind.Cloud,
        path: '/owned-test-state',
    }).run(stop.signal);
    try {
        await vi.waitFor((): void => {
            expect(capture.model?.phase).toBe(ConnectorConsolePhase.Unavailable);
        });
        expect(capture.model?.message).toContain('Windows folder permissions block the connector');
        expect(log).toHaveBeenCalledWith('startup-failed', {
            stage: 'Checking saved configuration',
            reason: 'folder-permissions',
            code: WindowsStateFailure.Untrusted,
        });
        capture.command?.(ConnectorConsoleCommand.Reconnect);
        await vi.waitFor((): void => {
            expect(load).toHaveBeenCalledTimes(2);
        });
        expect(prepare).not.toHaveBeenCalled();
    } finally {
        stop.abort();
        await running;
        for (const [target, descriptor] of [
            [process.stdin, tty[0]],
            [process.stdout, tty[1]],
        ] as const) {
            if (descriptor === undefined) {
                Reflect.deleteProperty(target, 'isTTY');
            } else {
                Object.defineProperty(target, 'isTTY', descriptor);
            }
        }
    }
});

/** A delayed local operation retains normal cooperative cancellation and unregisters its exact listener. */
async function stopped(signal: AbortSignal): Promise<void> {
    const done: PromiseWithResolvers<undefined> = Promise.withResolvers<undefined>();
    const abort: () => void = (): void => done.resolve(undefined);
    signal.addEventListener('abort', abort, { once: true });
    try {
        if (signal.aborted) {
            abort();
        }
        await done.promise;
    } finally {
        signal.removeEventListener('abort', abort);
    }
}

it('first startup reports secure local work before I/O and remains visibly alive through a delayed two-minute operation', async (): Promise<void> => {
    vi.useFakeTimers();
    vi.spyOn(ConnectorCloudConfiguration, 'prepare').mockImplementation(
        async (_directory: string, signal: AbortSignal): Promise<string> => {
            await stopped(signal);
            signal.throwIfAborted();
            throw new Error('Fixture stopped');
        },
    );
    const stop: AbortController = new AbortController();
    const running: Promise<void> = new ConnectorConsoleApp({
        kind: ConnectorConsoleSourceKind.Cloud,
        path: '/owned-test-state',
    }).run(stop.signal);
    try {
        expect(capture.frames.at(-1)).toContain('Checking secure local storage · 0s');
        await vi.advanceTimersByTimeAsync(120000);
        expect(capture.frames.at(-1)).toContain('Checking secure local storage · 120s');
        expect(capture.model?.phase).toBe(ConnectorConsolePhase.Connecting);
        expect(capture.frames.length).toBeLessThanOrEqual(125);
        expect(capture.frames.join('\n')).not.toContain('%');
    } finally {
        stop.abort();
        await running;
    }
    expect(vi.getTimerCount()).toBe(0);
});

it('reconnect names the previous-owner drain while joining it, then starts the next attempt without overlapping local owners', async (): Promise<void> => {
    vi.useFakeTimers();
    const drain: PromiseWithResolvers<undefined> = Promise.withResolvers<undefined>();
    let starts: number = 0;
    vi.spyOn(ConnectorCloudConfiguration, 'prepare').mockImplementation(
        async (_directory: string, signal: AbortSignal): Promise<string> => {
            starts++;
            const first: boolean = starts === 1;
            await stopped(signal);
            if (first) {
                await drain.promise;
            }
            signal.throwIfAborted();
            throw new Error('Fixture stopped');
        },
    );
    const stop: AbortController = new AbortController();
    const running: Promise<void> = new ConnectorConsoleApp({
        kind: ConnectorConsoleSourceKind.Cloud,
        path: '/owned-test-state',
    }).run(stop.signal);
    try {
        const command: ((command: ConnectorConsoleCommand) => void) | null = capture.command;
        if (command === null) {
            throw new Error('Terminal command observer required');
        }
        command(ConnectorConsoleCommand.Reconnect);
        await vi.advanceTimersByTimeAsync(2000);
        expect(starts).toBe(1);
        expect(capture.frames.at(-1)).toContain('Closing previous connection · 2s');
        drain.resolve(undefined);
        await vi.advanceTimersByTimeAsync(0);
        expect(starts).toBe(2);
        expect(capture.frames.at(-1)).toContain('Checking secure local storage · 0s');
    } finally {
        drain.resolve(undefined);
        stop.abort();
        await running;
    }
    expect(vi.getTimerCount()).toBe(0);
});

it('a delayed system probe has independent elapsed progress and preserves its exact result and connection state', async (): Promise<void> => {
    vi.useFakeTimers();
    vi.spyOn(ConnectorCloudConfiguration, 'prepare').mockImplementation(
        async (_directory: string, signal: AbortSignal): Promise<string> => {
            await stopped(signal);
            signal.throwIfAborted();
            throw new Error('Fixture stopped');
        },
    );
    const probe: PromiseWithResolvers<SystemSpecification> =
        Promise.withResolvers<SystemSpecification>();
    const read: MockInstance<typeof SystemInfo.read> = vi.spyOn(SystemInfo, 'read');
    read.mockImplementation(async (signal: AbortSignal): Promise<SystemSpecification> => {
        signal.throwIfAborted();
        const result: SystemSpecification = await probe.promise;
        signal.throwIfAborted();
        return result;
    });
    const stop: AbortController = new AbortController();
    const running: Promise<void> = new ConnectorConsoleApp({
        kind: ConnectorConsoleSourceKind.Cloud,
        path: '/owned-test-state',
    }).run(stop.signal);
    try {
        const command: ((command: ConnectorConsoleCommand) => void) | null = capture.command;
        if (command === null) {
            throw new Error('Terminal command observer required');
        }
        command(ConnectorConsoleCommand.System);
        await vi.advanceTimersByTimeAsync(120000);
        expect(capture.frames.at(-1)).toContain('Reading CPU, memory and GPUs · 120s');
        expect(capture.model?.activity).toContain('Checking secure local storage · 120s');
        expect(capture.model?.phase).toBe(ConnectorConsolePhase.Connecting);
        probe.resolve(specification);
        await vi.advanceTimersByTimeAsync(0);
        expect(read).toHaveBeenCalledTimes(1);
        expect(capture.model?.details).toEqual(['Fixture CPU · 4 CPUs', 'Memory: 4 GiB']);
    } finally {
        probe.resolve(specification);
        stop.abort();
        await running;
    }
    expect(vi.getTimerCount()).toBe(0);
});

const specification: SystemSpecification = {
    observedAtMs: '1',
    platform: SystemPlatform.Windows,
    architecture: 'x64',
    osRelease: 'fixture',
    cpuModel: 'Fixture CPU',
    logicalCpuCount: 4,
    totalMemoryBytes: '4294967296',
    availableMemoryBytes: '2147483648',
    gpuState: GpuInventoryState.Reported,
    gpus: [],
};

it('no startup progress runs while the person answers the first-run questions', async (): Promise<void> => {
    vi.useFakeTimers();
    const prepare: MockInstance<typeof ConnectorCloudConfiguration.prepare> = vi.spyOn(
        ConnectorCloudConfiguration,
        'prepare',
    );
    vi.spyOn(ConnectorSetupSession.prototype, 'load').mockResolvedValue(null);
    const seen: string[] = [];
    vi.spyOn(ConnectorSetupSession.prototype, 'review').mockImplementation(
        async (_questions: ConnectorPermissionQuestions): Promise<boolean> => {
            for (let second: number = 0; second < 60; second++) {
                await new Promise<void>((resolve: () => void): void => {
                    setTimeout(resolve, 1000);
                });
                seen.push(capture.model?.activity ?? '');
            }
            return false;
        },
    );
    const tty: readonly [PropertyDescriptor | undefined, PropertyDescriptor | undefined] = [
        Object.getOwnPropertyDescriptor(process.stdin, 'isTTY'),
        Object.getOwnPropertyDescriptor(process.stdout, 'isTTY'),
    ];
    Object.defineProperty(process.stdin, 'isTTY', { value: true, configurable: true });
    Object.defineProperty(process.stdout, 'isTTY', { value: true, configurable: true });
    try {
        const running: Promise<void> = new ConnectorConsoleApp({
            kind: ConnectorConsoleSourceKind.Cloud,
            path: '/owned-test-state',
        }).run(new AbortController().signal);
        await vi.advanceTimersByTimeAsync(61000);
        await running;
    } finally {
        for (const [target, descriptor] of [
            [process.stdin, tty[0]],
            [process.stdout, tty[1]],
        ] as const) {
            if (descriptor === undefined) {
                Reflect.deleteProperty(target, 'isTTY');
            } else {
                Object.defineProperty(target, 'isTTY', descriptor);
            }
        }
    }
    expect(capture.prompts).toBe(1);
    expect(seen).toHaveLength(60);
    expect(seen.every((activity: string): boolean => activity === '')).toBe(true);
    expect(capture.frames.join('\n')).not.toContain('Checking secure local storage');
    expect(capture.model?.phase).toBe(ConnectorConsolePhase.Starting);
    expect(prepare).not.toHaveBeenCalled();
    expect(vi.getTimerCount()).toBe(0);
});
