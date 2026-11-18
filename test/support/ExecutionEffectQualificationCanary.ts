// SPDX-FileCopyrightText: 2026 Nerva contributors
// SPDX-License-Identifier: LicenseRef-Proprietary

import { constants, type BigIntStats } from 'node:fs';
import { spawn, type ChildProcess } from 'node:child_process';
import {
    open,
    mkdir,
    lstat,
    readFile,
    rmdir,
    stat,
    writeFile,
    type FileHandle,
} from 'node:fs/promises';
import { setTimeout as delay } from 'node:timers/promises';
import type { ConnectorCapturedExecutionEffect } from '../../src/runtime/ConnectorEffectContext.js';
import { ConnectorNativeExecutable } from '../../src/runtime/ConnectorNativeExecutable.js';
import { WorkspaceIdentityProcess } from '../../src/workspace/WorkspaceIdentityProcess.js';
import type { ExecutionCgroupIdentity } from '../../src/execution/ExecutionCgroupIdentity.js';
import { ExecutionCgroupIdentityCodec } from '../../src/execution/ExecutionCgroupIdentityCodec.js';
import type { ExecutionOutput } from 'nerva-connector-protocol/execution/ExecutionOutput.js';
import { requireEffect } from './ExecutionEffectQualificationTypes.js';

/** A trusted unsandboxed fixture child proves group ownership and liveness, never application confinement. */
const CANARY: string = `import fs from 'node:fs';process.stdin.once('data',()=>{fs.appendFileSync(process.argv[1],'x');process.stdout.write(Buffer.from([239,187,191,0,255]));process.stderr.write(Buffer.from([0,254,69]));setInterval(()=>fs.appendFileSync(process.argv[2],'x'),50)});`;

/** Retains exact raw kernel capabilities so a successful production recovery may remove the group without leaking a second hidden owner. */
export class ExecutionEffectQualificationCanary implements AsyncDisposable {
    #child: ChildProcess | null = null;
    #done: Promise<void> | null = null;
    #timer: NodeJS.Timeout | null = null;
    #closing: Promise<void> | null = null;
    readonly #stdout: Buffer[] = [];
    readonly #stderr: Buffer[] = [];
    #out: number = 0;
    #err: number = 0;
    #invalid: boolean = false;
    #expired: boolean = false;
    #heartbeat: string | null = null;
    private constructor(
        public readonly identity: ExecutionCgroupIdentity,
        public readonly directory: FileHandle,
        public readonly parent: FileHandle,
        public readonly name: string,
        public readonly resources: AsyncDisposableStack,
    ) {}

    /** Every created directory is below one captured owned parent and bounded before a child can run. */
    public static async create(
        context: ConnectorCapturedExecutionEffect,
        id: string,
    ): Promise<ExecutionEffectQualificationCanary> {
        requireEffect(/^[a-f0-9]{64}$/u.test(id));
        await using resources: AsyncDisposableStack = new AsyncDisposableStack();
        const helper: FileHandle = resources.use(
            await ConnectorNativeExecutable.open(
                context.cgroupHelperFile,
                context.cgroupHelperSha256,
            ),
        );
        const capture: WorkspaceIdentityProcess = resources.use(new WorkspaceIdentityProcess());
        const parent: FileHandle = resources.use(
            await open(
                context.cgroupRoot,
                constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW,
            ),
        );
        const signal: AbortSignal = AbortSignal.timeout(3000);
        requireEffect(
            ExecutionCgroupIdentityCodec.same(
                await capture.cgroup({
                    descriptor: parent.fd,
                    helperDescriptor: helper.fd,
                    signal,
                }),
                context.delegation,
            ),
        );
        const name: string = 'exec-' + id;
        const path: string = '/proc/self/fd/' + parent.fd.toString() + '/' + name;
        await mkdir(path);
        try {
            const directory: FileHandle = resources.use(
                await open(path, constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW),
            );
            const identity: ExecutionCgroupIdentity = await capture.cgroup({
                descriptor: directory.fd,
                helperDescriptor: helper.fd,
                signal,
            });
            for (const [file, value] of [
                ['memory.max', '67108864'],
                ['memory.swap.max', '0'],
                ['pids.max', '8'],
                ['cpu.max', '50000 100000'],
            ]) {
                if (file === undefined || value === undefined) {
                    throw new Error('Incomplete fixture cgroup bound');
                }
                await writeFile(path + '/' + file, value);
            }
            return new ExecutionEffectQualificationCanary(
                identity,
                directory,
                parent,
                name,
                resources.move(),
            );
        } catch (caught: unknown) {
            await rmdir(path);
            throw caught;
        }
    }

    /** The fixed child waits for membership before producing any fixture effect or binary prefix. */
    public async start(
        interpreter: FileHandle,
        effect: string,
        heartbeat: string,
    ): Promise<ExecutionOutput> {
        requireEffect(this.#child === null && this.#closing === null);
        this.#heartbeat = heartbeat;
        await writeFile(heartbeat, '', { mode: 0o600 });
        const child: ChildProcess = spawn(
            '/proc/self/fd/3',
            [
                '--single-threaded',
                '--v8-pool-size=1',
                '--max-old-space-size=8',
                '--input-type=module',
                '-e',
                CANARY,
                effect,
                heartbeat,
            ],
            {
                env: { LANG: 'C', LC_ALL: 'C', NODE_OPTIONS: '' },
                stdio: ['pipe', 'pipe', 'pipe', interpreter.fd],
            },
        );
        this.#child = child;
        const done: PromiseWithResolvers<undefined> = Promise.withResolvers<undefined>();
        this.#done = done.promise;
        child.once('error', (): void => {
            this.#invalid = true;
        });
        child.once('close', (): void => {
            done.resolve(undefined);
        });
        child.stdout?.on('data', (bytes: Buffer): void => {
            this.#out += bytes.byteLength;
            if (this.#out > 4096) {
                this.#invalid = true;
                child.kill('SIGKILL');
            } else {
                this.#stdout.push(bytes);
            }
        });
        child.stderr?.on('data', (bytes: Buffer): void => {
            this.#err += bytes.byteLength;
            if (this.#err > 4096) {
                this.#invalid = true;
                child.kill('SIGKILL');
            } else {
                this.#stderr.push(bytes);
            }
        });
        child.stdin?.once('error', (): void => {
            this.#invalid = true;
            child.kill('SIGKILL');
        });
        this.#timer = setTimeout((): void => {
            this.#expired = true;
            child.kill('SIGKILL');
        }, 12000);
        const pid: number | undefined = child.pid;
        requireEffect(pid !== undefined && child.stdin !== null);
        if (pid === undefined || child.stdin === null) {
            throw new Error('Owned canary failed to start');
        }
        try {
            await writeFile(this.#path('cgroup.procs'), pid.toString());
            child.stdin.end('go');
            const deadline: number = performance.now() + 3000;
            while (this.#out !== 5 || this.#err !== 3) {
                requireEffect(
                    !this.#invalid &&
                        child.exitCode === null &&
                        child.signalCode === null &&
                        performance.now() < deadline,
                );
                await delay(10);
            }
        } catch (caught: unknown) {
            child.kill('SIGKILL');
            await done.promise;
            throw caught;
        }
        return {
            stdoutBase64: Buffer.concat(this.#stdout, this.#out).toString('base64'),
            stderrBase64: Buffer.concat(this.#stderr, this.#err).toString('base64'),
        };
    }

    /** Continued heartbeat and actual kernel membership distinguish refusal from killing the foreign group. */
    public async alive(): Promise<void> {
        const child: ChildProcess | null = this.#child;
        const heartbeat: string | null = this.#heartbeat;
        requireEffect(child !== null && heartbeat !== null);
        if (child === null || heartbeat === null) {
            throw new Error('Owned live canary required');
        }
        const before: bigint = (await stat(heartbeat, { bigint: true })).size;
        const deadline: number = performance.now() + 2000;
        while ((await stat(heartbeat, { bigint: true })).size <= before) {
            requireEffect(
                !this.#invalid &&
                    child.exitCode === null &&
                    child.signalCode === null &&
                    performance.now() < deadline,
            );
            await delay(10);
        }
        requireEffect(/^populated 1$/mu.test(await readFile(this.#path('cgroup.events'), 'utf8')));
    }

    /** Matching production recovery must join the exact fixture child rather than merely hide its pathname. */
    public async killed(): Promise<void> {
        requireEffect(this.#done !== null);
        if (this.#done === null) {
            throw new Error('Owned child was not started');
        }
        await this.#done;
        requireEffect(!this.#expired && this.#child?.signalCode === 'SIGKILL');
    }

    #path(leaf: string): string {
        return '/proc/self/fd/' + this.directory.fd.toString() + '/' + leaf;
    }

    /** Exact retained capabilities own cleanup even when a test deliberately replaces the visible parent path. */
    public async [Symbol.asyncDispose](): Promise<void> {
        this.#closing ??= this.#dispose();
        await this.#closing;
    }

    async #dispose(): Promise<void> {
        try {
            const status: BigIntStats = await this.directory.stat({ bigint: true });
            let removed: boolean = status.nlink === 0n;
            if (!removed) {
                try {
                    await writeFile(this.#path('cgroup.kill'), '1');
                } catch (caught: unknown) {
                    if (caught instanceof Error && 'code' in caught && caught.code === 'ENOENT') {
                        removed = true;
                    } else {
                        throw caught;
                    }
                }
            }
            await this.#done;
            if (!removed) {
                const deadline: number = performance.now() + 3000;
                while (
                    !/^populated 0$/mu.test(await readFile(this.#path('cgroup.events'), 'utf8'))
                ) {
                    requireEffect(performance.now() < deadline);
                    await delay(10);
                }
                const path: string = '/proc/self/fd/' + this.parent.fd.toString() + '/' + this.name;
                const current: BigIntStats = await lstat(path, { bigint: true });
                requireEffect(current.dev === status.dev && current.ino === status.ino);
                await rmdir(path);
            }
        } catch (caught: unknown) {
            this.#child?.kill('SIGKILL');
            await this.#done;
            throw caught;
        } finally {
            if (this.#timer !== null) {
                clearTimeout(this.#timer);
            }
            await this.resources[Symbol.asyncDispose]();
        }
    }
}
