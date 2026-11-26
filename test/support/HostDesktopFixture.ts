// SPDX-FileCopyrightText: 2026 Dacely <business@dacely.com>
// SPDX-License-Identifier: LicenseRef-Proprietary

import { spawn, execFile, type ChildProcess } from 'node:child_process';
import { promisify } from 'node:util';
import { Readable } from 'node:stream';
import { HostWorkspace } from '../../src/host/HostWorkspace.js';
import { HostWorkspaceFixture } from './HostWorkspaceFixture.js';

/** Own an isolated display and real event-reporting X11 application without touching the user's desktop. */
export class HostDesktopFixture implements AsyncDisposable {
    readonly #displayProcess: ChildProcess;
    #application: ChildProcess | null = null;
    #workspace: HostWorkspace | null = null;
    #events: string = '';
    #display: string = '';

    private constructor(public readonly files: HostWorkspaceFixture) {
        this.#displayProcess = spawn(
            'Xvfb',
            ['-displayfd', '3', '-screen', '0', '800x600x24', '-nolisten', 'tcp'],
            { stdio: ['ignore', 'ignore', 'pipe', 'pipe'] },
        );
        this.#displayProcess.stderr?.resume();
    }

    /** Xvfb chooses a free display and reports its actual identity on an owned pipe. */
    public static async create(): Promise<HostDesktopFixture> {
        const fixture: HostDesktopFixture = new HostDesktopFixture(
            await HostWorkspaceFixture.create(),
        );
        try {
            fixture.#display = await fixture.#ready();
            fixture.#workspace = await HostWorkspace.create({
                directory: fixture.files.directory,
                authorization: fixture.files,
                desktopEnvironment: {
                    DISPLAY: fixture.#display,
                    XAUTHORITY: '',
                    WAYLAND_DISPLAY: '',
                },
            });
            fixture.#application = spawn(
                'xev',
                [
                    '-geometry',
                    '400x300+20+20',
                    '-name',
                    'NervaDesktopTest',
                    '-event',
                    'keyboard',
                    '-event',
                    'mouse',
                    '-event',
                    'button',
                ],
                {
                    env: { ...process.env, DISPLAY: fixture.#display, XAUTHORITY: '' },
                    stdio: ['ignore', 'pipe', 'pipe'],
                },
            );
            fixture.#application.stdout?.setEncoding('utf8');
            fixture.#application.stdout?.on('data', (chunk: string): void => {
                fixture.#events = (fixture.#events + chunk).slice(-65536);
            });
            fixture.#application.stderr?.resume();
            const result: Awaited<ReturnType<typeof execFile.__promisify__>> = await promisify(
                execFile,
            )('xdotool', ['search', '--sync', '--name', '^NervaDesktopTest$'], {
                env: fixture.environment,
                timeout: 5000,
                maxBuffer: 4096,
            });
            const window: string = result.stdout.toString().trim();
            if (!/^[0-9]+$/u.test(window)) {
                throw new Error('Isolated desktop fixture did not create its window');
            }
            await promisify(execFile)('xdotool', ['windowfocus', '--sync', window], {
                env: fixture.environment,
                timeout: 5000,
                maxBuffer: 4096,
            });
            return fixture;
        } catch (caught: unknown) {
            await fixture[Symbol.asyncDispose]();
            throw caught;
        }
    }

    /** Actual event data from the owned X11 window, bounded independently of the runtime. */
    public get events(): string {
        return this.#events;
    }

    /** One environment addresses only the display created by this fixture. */
    public get environment(): NodeJS.ProcessEnv {
        return { ...process.env, DISPLAY: this.#display, XAUTHORITY: '', WAYLAND_DISPLAY: '' };
    }

    /** Desktop runtime access is valid only after fixture initialization. */
    public get host(): HostWorkspace {
        if (this.#workspace === null) {
            throw new Error('Desktop fixture unavailable');
        }
        return this.#workspace;
    }

    /** Stop the runtime before the display so owned held inputs can be released. */
    public async [Symbol.asyncDispose](): Promise<void> {
        try {
            await this.#workspace?.[Symbol.asyncDispose]();
        } finally {
            try {
                await this.#stop(this.#application);
                await this.#stop(this.#displayProcess);
            } finally {
                await this.files[Symbol.asyncDispose]();
            }
        }
    }

    async #ready(): Promise<string> {
        const pipe: Readable | null | undefined =
            this.#displayProcess.stdio[3] instanceof Readable
                ? this.#displayProcess.stdio[3]
                : null;
        if (pipe === null || pipe === undefined) {
            throw new Error('Xvfb readiness pipe unavailable');
        }
        return await new Promise<string>(
            (resolve: (display: string) => void, reject: (error: Error) => void): void => {
                let output: string = '';
                const timer: NodeJS.Timeout = setTimeout(
                    (): void => reject(new Error('Xvfb readiness expired')),
                    5000,
                );
                this.#displayProcess.once('error', (error: Error): void => {
                    clearTimeout(timer);
                    reject(error);
                });
                this.#displayProcess.once('exit', (): void =>
                    reject(new Error('Xvfb exited before readiness')),
                );
                pipe.setEncoding('utf8');
                pipe.on('data', (chunk: string): void => {
                    output += chunk;
                    if (output.length > 64) {
                        clearTimeout(timer);
                        reject(new Error('Invalid Xvfb readiness'));
                        return;
                    }
                    if (output.endsWith('\n')) {
                        clearTimeout(timer);
                        if (!/^[0-9]{1,5}\n$/u.test(output)) {
                            reject(new Error('Invalid Xvfb display identity'));
                        } else {
                            resolve(':' + output.trim());
                        }
                    }
                });
            },
        );
    }

    async #stop(child: ChildProcess | null): Promise<void> {
        if (
            child === null ||
            child.pid === undefined ||
            child.exitCode !== null ||
            child.signalCode !== null
        ) {
            return;
        }
        await new Promise<void>((resolve: () => void): void => {
            const timer: NodeJS.Timeout = setTimeout((): void => {
                child.kill('SIGKILL');
            }, 1000);
            child.once('close', (): void => {
                clearTimeout(timer);
                resolve();
            });
            child.kill('SIGTERM');
        });
    }
}
