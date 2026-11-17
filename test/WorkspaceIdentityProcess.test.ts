// SPDX-FileCopyrightText: 2026 Nerva contributors
// SPDX-License-Identifier: LicenseRef-Proprietary

import { execFile } from 'node:child_process';
import { constants } from 'node:fs';
import { getEventListeners } from 'node:events';
import { mkdtemp, writeFile, open, readFile, rm, type FileHandle } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { promisify } from 'node:util';
import { expect, it } from 'vitest';
import { ConnectorFileMode } from 'nerva-connector-protocol/protocol/ConnectorFiles.js';
import { WorkspaceIdentityProcess } from '../src/workspace/WorkspaceIdentityProcess.js';
import {
    WorkspaceIdentityFailure,
    type WorkspaceIdentityResult,
} from '../src/workspace/WorkspaceIdentity.js';
import type { WorkspaceInspection } from '../src/workspace/WorkspaceInspection.js';

/** This native test program exercises pipe/lifecycle boundaries only, never filesystem confinement. */
const source: string = String.raw`
#include <unistd.h>
#include <fcntl.h>
#include <stdio.h>
#include <string.h>
#include <stdlib.h>
int main(int argc,char **argv) {
  char mode[32]={0};
  if(argc!=2 || strcmp(argv[1],"--inspect-root")!=0 || !getenv("NERVA_CONNECTOR_PARENT_PID")) return 3;
  int f=openat(4,"mode",O_RDONLY); if(f<0 || read(f,mode,31)<0) return 3; close(f);
  char input; if(read(0,&input,1)!=0) return 3;
  if(strcmp(mode,"wait")==0) {
    int ready=openat(4,"ready",O_WRONLY|O_CREAT|O_EXCL,0600);
    if(ready>=0) { dprintf(ready,"%ld",(long)getpid());close(ready); }
    for(;;) pause();
  }
  if(strcmp(mode,"overflow")==0) { char bytes[2048];memset(bytes,'x',sizeof(bytes));if(write(1,bytes,sizeof(bytes))<0) return 3;return 0; }
  if(strcmp(mode,"stderr")==0 && write(2,"private diagnostic",18)<0) return 3;
  if(strcmp(mode,"malformed")==0) { if(write(1,"not-json",8)<0) return 3;return 0; }
  dprintf(1,"{\"ok\":false,\"error\":\"unsupported\"}");
  return strcmp(mode,"wrong-exit")==0 ? 0 : 1;
}
`;

/** Owns only a temporary test executable, directory and descriptors; it is not a product helper. */
class ProcessFixture implements AsyncDisposable {
    readonly #helper: FileHandle;
    readonly #root: FileHandle;
    private constructor(
        public readonly directory: string,
        helper: FileHandle,
        root: FileHandle,
    ) {
        this.#helper = helper;
        this.#root = root;
    }

    /** Compile once per lifecycle cohort using the existing system compiler. */
    public static async create(): Promise<ProcessFixture> {
        const directory: string = await mkdtemp(join(homedir(), '.nerva-inspector-process-'));
        try {
            const path: string = join(directory, 'helper');
            const code: string = join(directory, 'helper.c');
            await writeFile(code, source, { mode: 0o600 });
            await promisify(execFile)('cc', ['-O2', '-Wall', '-Werror', code, '-o', path], {
                timeout: 10000,
                maxBuffer: 4096,
            });
            const helper: FileHandle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
            try {
                const root: FileHandle = await open(
                    directory,
                    constants.O_RDONLY | constants.O_DIRECTORY,
                );
                return new ProcessFixture(directory, helper, root);
            } catch (caught: unknown) {
                await helper.close();
                throw caught;
            }
        } catch (caught: unknown) {
            await rm(directory, { recursive: true, force: true });
            throw caught;
        }
    }

    /** Borrowed handles stay valid until the inspector has joined its exact child. */
    public inspection(signal: AbortSignal): WorkspaceInspection {
        return {
            descriptor: this.#root.fd,
            helperDescriptor: this.#helper.fd,
            access: ConnectorFileMode.ReadOnly,
            signal,
        };
    }

    /** Select one deterministic process behavior. */
    public async mode(value: string): Promise<void> {
        await writeFile(join(this.directory, 'mode'), value, { mode: 0o600 });
    }

    /** A bounded rendezvous proves cancellation happens after the native process is alive. */
    public async ready(): Promise<number> {
        const deadline: number = performance.now() + 2000;
        while (performance.now() < deadline) {
            try {
                const pid: number = Number(await readFile(join(this.directory, 'ready'), 'utf8'));
                if (Number.isSafeInteger(pid) && pid > 0) {
                    return pid;
                }
            } catch (caught: unknown) {
                if (!(caught instanceof Error) || !('code' in caught) || caught.code !== 'ENOENT') {
                    throw caught;
                }
            }
            await delay(5);
        }
        throw new Error('Native process rendezvous expired');
    }

    /** Descriptors close before removing the task-owned fixture. */
    public async [Symbol.asyncDispose](): Promise<void> {
        await this.#root.close();
        await this.#helper.close();
        await rm(this.directory, { recursive: true, force: true });
    }
}

it.skipIf(process.platform !== 'linux')(
    'accepts explicit unsupported but rejects malformed, excess, stderr and wrong-exit native replies',
    async (): Promise<void> => {
        await using fixture: ProcessFixture = await ProcessFixture.create();
        await using owner: WorkspaceIdentityProcess = new WorkspaceIdentityProcess();
        const signal: AbortSignal = new AbortController().signal;
        for (const mode of ['unsupported', 'malformed', 'overflow', 'stderr', 'wrong-exit']) {
            await fixture.mode(mode);
            const result: WorkspaceIdentityResult = await owner.inspect(fixture.inspection(signal));
            expect(result.ok).toBe(false);
            if (!result.ok) {
                expect(result.error).toBe(
                    mode === 'unsupported'
                        ? WorkspaceIdentityFailure.Unsupported
                        : mode === 'malformed' || mode === 'wrong-exit'
                          ? WorkspaceIdentityFailure.Invalid
                          : WorkspaceIdentityFailure.Unavailable,
                );
            }
            expect(getEventListeners(signal, 'abort')).toHaveLength(0);
        }
    },
);

it.skipIf(process.platform !== 'linux')(
    'abort and disposal join exact children; at most two inspections are admitted without a queue',
    async (): Promise<void> => {
        await using fixture: ProcessFixture = await ProcessFixture.create();
        await fixture.mode('wait');
        await using owner: WorkspaceIdentityProcess = new WorkspaceIdentityProcess();
        const stop: AbortController = new AbortController();
        const first: Promise<WorkspaceIdentityResult> = owner.inspect(
            fixture.inspection(stop.signal),
        );
        const pid: number = await fixture.ready();
        const second: Promise<WorkspaceIdentityResult> = owner.inspect(
            fixture.inspection(stop.signal),
        );
        expect(await owner.inspect(fixture.inspection(stop.signal))).toEqual({
            ok: false,
            error: WorkspaceIdentityFailure.Unavailable,
        });
        stop.abort();
        expect(await first).toEqual({ ok: false, error: WorkspaceIdentityFailure.Unavailable });
        expect(await second).toEqual({ ok: false, error: WorkspaceIdentityFailure.Unavailable });
        expect((): boolean => process.kill(pid, 0)).toThrow();
        expect(getEventListeners(stop.signal, 'abort')).toHaveLength(0);
        await rm(join(fixture.directory, 'ready'));
        const active: Promise<WorkspaceIdentityResult> = owner.inspect(
            fixture.inspection(new AbortController().signal),
        );
        const disposedPid: number = await fixture.ready();
        await owner[Symbol.asyncDispose]();
        expect(await active).toEqual({ ok: false, error: WorkspaceIdentityFailure.Unavailable });
        expect((): boolean => process.kill(disposedPid, 0)).toThrow();
        expect(await owner.inspect(fixture.inspection(new AbortController().signal))).toEqual({
            ok: false,
            error: WorkspaceIdentityFailure.Unavailable,
        });
    },
);

it.skipIf(process.platform !== 'linux')(
    'the owned deadline kills and joins a live native inspector and releases its abort listener',
    async (): Promise<void> => {
        await using fixture: ProcessFixture = await ProcessFixture.create();
        await using owner: WorkspaceIdentityProcess = new WorkspaceIdentityProcess();
        await fixture.mode('wait');
        const signal: AbortSignal = new AbortController().signal;
        const active: Promise<WorkspaceIdentityResult> = owner.inspect(fixture.inspection(signal));
        const pid: number = await fixture.ready();
        expect(await active).toEqual({ ok: false, error: WorkspaceIdentityFailure.Unavailable });
        expect((): boolean => process.kill(pid, 0)).toThrow();
        expect(getEventListeners(signal, 'abort')).toHaveLength(0);
    },
);
