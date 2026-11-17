// SPDX-FileCopyrightText: 2026 Nerva contributors
// SPDX-License-Identifier: LicenseRef-Proprietary

import { execFile } from 'node:child_process';
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { ExecutionFixture } from './ExecutionFixture.js';

/** An actual confined descendant reports EOF through a durable marker, never through fabricated protocol frames. */
export class ExecutionPipeDescendantFixture implements AsyncDisposable {
    readonly #resources: AsyncDisposableStack;
    private constructor(
        resources: AsyncDisposableStack,
        public readonly native: ExecutionFixture,
    ) {
        this.#resources = resources;
    }

    /** One task-owned static probe and the usual native/cgroup fixture are removed together on every exit. */
    public static async create(helper: string): Promise<ExecutionPipeDescendantFixture> {
        await using resources: AsyncDisposableStack = new AsyncDisposableStack();
        const directory: string = await mkdtemp(join(homedir(), '.nerva-descendant-eof-'));
        resources.defer(async (): Promise<void> => {
            await rm(directory, { recursive: true, force: true });
        });
        const source: string = join(directory, 'probe.c');
        const probe: string = join(directory, 'probe');
        await writeFile(
            source,
            `#define _GNU_SOURCE
#include <errno.h>
#include <fcntl.h>
#include <signal.h>
#include <stdlib.h>
#include <string.h>
#include <sys/stat.h>
#include <unistd.h>
static int mark(const char *name) {
    int fd = open(name, O_CREAT | O_EXCL | O_WRONLY, 0600);
    if (fd < 0) return 1;
    int failed = write(fd, "observed", 8) != 8;
    close(fd);
    return failed;
}
int main(void) {
    char cwd[512]; struct stat info;
    if (!getcwd(cwd, sizeof(cwd)) || strcmp(cwd, "/workspace/nested")) return 10;
    if (fstat(0, &info) || !S_ISFIFO(info.st_mode)) return 11;
    pid_t child = fork();
    if (child < 0) return 12;
    if (child > 0) { for (;;) pause(); }
    errno = 0;
    if (setsid() != -1 || errno != EPERM) return 16;
    errno = 0;
    if (setpgid(0, 0) != -1 || errno != EPERM) return 17;
    if (mark("descendant-ready")) return 13;
    char bytes[1024];
    for (;;) {
        ssize_t count = read(0, bytes, sizeof(bytes));
        if (count < 0 && errno == EINTR) continue;
        if (count < 0) return 14;
        if (!count) break;
    }
    if (mark("descendant-eof")) return 15;
    return write(2, "DESCENDANT EOF\\n", 15) != 15;
}
`,
            { mode: 0o600 },
        );
        await promisify(execFile)(
            'cc',
            ['-O2', '-static', '-Wall', '-Wextra', '-Werror', '-o', probe, source],
            { timeout: 10000, maxBuffer: 8192 },
        );
        const native: ExecutionFixture = resources.use(
            await ExecutionFixture.create(helper, { probeFile: probe }),
        );
        await mkdir(join(native.workspace, 'nested'), { mode: 0o700 });
        return new ExecutionPipeDescendantFixture(resources.move(), native);
    }

    /** The existing native owner joins the whole captured cgroup before the task-owned executable is removed. */
    public async [Symbol.asyncDispose](): Promise<void> {
        await this.#resources[Symbol.asyncDispose]();
    }
}
