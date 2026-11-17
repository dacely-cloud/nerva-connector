// SPDX-FileCopyrightText: 2026 Nerva contributors
// SPDX-License-Identifier: LicenseRef-Proprietary

import { createHash } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { expect, it } from 'vitest';
import { HostWorkspace } from '../src/host/HostWorkspace.js';
import { HostWindowsBuild } from '../src/host/HostWindowsBuild.js';
import { HostMcpWorkspaceTools } from '../src/host/HostMcpWorkspaceTools.js';
import type { HostEnvironmentReport } from '../src/host/HostEnvironmentTypes.js';
import { ConnectorHostErrorCode } from '../src/protocol/ConnectorHost.js';
import {
    HostFileKind,
    HostShell,
    HostWriteMode,
    type HostWorkspaceAuthorization,
    type HostWorkspaceAccess,
    type HostProcessRequest,
    type HostProcessSnapshot,
    type HostProcessOutput,
    type HostFileMetadata,
    type HostFileSnapshot,
    type HostFileRead,
    type HostDirectoryPage,
} from '../src/host/HostWorkspaceTypes.js';

/** Completed native output keeps exact binary data independent from the final lifecycle snapshot. */
interface WindowsWorkspaceCommand {
    readonly snapshot: HostProcessSnapshot;
    readonly stdout: Buffer;
    readonly stderr: Buffer;
}

/** One file-tree fixture borrows current verified broker assets and owns no desktop or external user path. */
class WindowsWorkspaceFixture implements AsyncDisposable, HostWorkspaceAuthorization {
    #workspace: HostWorkspace | null = null;
    #cleanup: Promise<void> | null = null;
    /** Revocation must deny observations and writes before their ordinary host operation begins. */
    public allowed: boolean = true;
    /** A separate file-tree owner avoids changing the already-delivered MCP or terminal fixtures. */
    private constructor(public readonly directory: string) {}
    /** The real Windows runtime starts only under the explicit test opt-in. */
    public static async create(): Promise<WindowsWorkspaceFixture> {
        const fixture: WindowsWorkspaceFixture = new WindowsWorkspaceFixture(
            await mkdtemp(join(tmpdir(), 'nerva Windows Files Å 日本 ')),
        );
        try {
            fixture.#workspace = await HostWorkspace.create({
                directory: fixture.directory,
                authorization: fixture,
                windowsLauncher: await HostWindowsBuild.verifiedExecutable(),
            });
            return fixture;
        } catch (error: unknown) {
            await fixture[Symbol.asyncDispose]();
            throw error;
        }
    }
    /** Every file and command access passes the ordinary local operation authority. */
    public authorize(_access: HostWorkspaceAccess): Promise<void> {
        if (!this.allowed) {
            return Promise.reject(new Error('Windows fixture authority revoked'));
        }
        return Promise.resolve();
    }
    /** Callers cannot use an owner that failed runtime construction. */
    public get host(): HostWorkspace {
        if (this.#workspace === null) {
            throw new Error('Windows workspace unavailable');
        }
        return this.#workspace;
    }
    /** One original native command is observed until root, Job and both EOF totals agree, then released. */
    public async execute(request: HostProcessRequest): Promise<WindowsWorkspaceCommand> {
        const started: HostProcessSnapshot = await this.host.start(request);
        let stdout: bigint = 0n;
        let stderr: bigint = 0n;
        const output: Buffer[] = [];
        const errors: Buffer[] = [];
        try {
            for (let attempt: number = 0; attempt < 750; attempt++) {
                const snapshot: HostProcessSnapshot = await this.host.output(
                    started.processId,
                    stdout,
                    stderr,
                    32768,
                );
                stdout = this.#append(output, snapshot.stdout, stdout);
                stderr = this.#append(errors, snapshot.stderr, stderr);
                if (
                    !snapshot.running &&
                    snapshot.treeRunning === false &&
                    snapshot.outputComplete
                ) {
                    if (
                        snapshot.stdoutFinalBytes === null ||
                        snapshot.stderrFinalBytes === null ||
                        snapshot.stdoutFinalBytes < stdout ||
                        snapshot.stderrFinalBytes < stderr ||
                        snapshot.stdoutFinalBytes > 262144n ||
                        snapshot.stderrFinalBytes > 262144n
                    ) {
                        throw new Error('Windows command has invalid final output counters');
                    }
                    if (
                        snapshot.stdoutFinalBytes === stdout &&
                        snapshot.stderrFinalBytes === stderr
                    ) {
                        return {
                            snapshot,
                            stdout: Buffer.concat(output),
                            stderr: Buffer.concat(errors),
                        };
                    }
                }
                await delay(20);
            }
            throw new Error('Windows command root/Job/EOF observation deadline exceeded');
        } finally {
            await this.host.release(started.processId);
        }
    }
    #append(parts: Buffer[], value: HostProcessOutput, cursor: bigint): bigint {
        if (
            value.truncated ||
            value.offset !== cursor ||
            value.nextOffset !== cursor + BigInt(value.bytes.length) ||
            value.nextOffset > value.endOffset ||
            value.nextOffset > 262144n ||
            parts.length >= 256
        ) {
            throw new Error('Windows command output exceeded exact bounded retention');
        }
        if (value.bytes.length > 0) {
            parts.push(value.bytes);
        }
        return value.nextOffset;
    }
    /** Native join must succeed before the only task-owned file tree is removed; failure retains its owner for retry. */
    public async [Symbol.asyncDispose](): Promise<void> {
        this.#cleanup ??= this.#dispose();
        try {
            await this.#cleanup;
        } catch (error: unknown) {
            this.#cleanup = null;
            throw error;
        }
    }
    async #dispose(): Promise<void> {
        await this.#workspace?.[Symbol.asyncDispose]();
        this.#workspace = null;
        await rm(this.directory, { recursive: true, force: true });
    }
}

/** A known complete descriptor generation is reused without unsafe number conversion. */
function snapshot(metadata: HostFileMetadata): HostFileSnapshot {
    return {
        identity: metadata.identity,
        size: metadata.size,
        modifiedAtNs: metadata.modifiedAtNs,
    };
}

/** Finite fixture programs use the real Windows native process path and ordinary user permissions. */
function command(
    executable: string | null,
    arguments_: readonly string[],
    shell: HostShell | null,
    text: string | null,
): HostProcessRequest {
    return {
        executable,
        arguments: arguments_,
        shell,
        command: text,
        directory: null,
        environment: {},
        timeoutMs: 20000,
    };
}

it.skipIf(process.platform !== 'win32' || process.env['NERVA_WINDOWS_WORKSPACE_SMOKE'] !== '1')(
    'actual Windows host workspace preserves binary files, snapshots, digest and atomic publication',
    async (): Promise<void> => {
        await using fixture: WindowsWorkspaceFixture = await WindowsWorkspaceFixture.create();
        const host: HostWorkspace = fixture.host;
        await host.mkdir('data é', false);
        const stage: string = join('data é', 'source.bin');
        const destination: string = join('data é', 'published.bin');
        const occupied: string = join('data é', 'occupied.bin');
        const body: Buffer = Buffer.alloc(65539);
        for (let index: number = 0; index < body.length; index++) {
            body[index] = index % 256;
        }
        expect(await host.write(stage, body.subarray(0, 32768), HostWriteMode.Create, 0n)).toBe(
            32768n,
        );
        expect(await host.write(stage, body.subarray(32768), HostWriteMode.Update, 32768n)).toBe(
            BigInt(body.length - 32768),
        );
        const patch: Buffer = Buffer.from([255, 0, 42]);
        expect(await host.write(stage, patch, HostWriteMode.Update, 123n)).toBe(3n);
        patch.copy(body, 123);
        const tail: Buffer = Buffer.from([0, 26, 255, 10]);
        expect(await host.write(stage, tail, HostWriteMode.Append, 0n)).toBe(4n);
        const expected: Buffer = Buffer.concat([body, tail]);
        const metadata: HostFileMetadata = await host.stat(stage);
        expect(metadata.kind).toBe(HostFileKind.File);
        expect(metadata.size).toBe(BigInt(expected.length));
        const chunks: Buffer[] = [];
        let offset: bigint = 0n;
        for (;;) {
            const read: HostFileRead = await host.read(stage, offset, 19001, snapshot(metadata));
            expect(read.offset).toBe(offset);
            expect(read.nextOffset).toBe(offset + BigInt(read.bytes.length));
            chunks.push(read.bytes);
            offset = read.nextOffset;
            if (read.eof) {
                break;
            }
            if (chunks.length > 8 || read.bytes.length === 0) {
                throw new Error('File read made no bounded progress');
            }
        }
        expect(Buffer.concat(chunks)).toEqual(expected);
        expect(await host.digest(stage, snapshot(metadata))).toMatchObject({
            algorithm: 'sha256',
            digest: createHash('sha256').update(expected).digest('hex'),
            size: BigInt(expected.length),
        });
        await host.write(occupied, Buffer.from('preserved'), HostWriteMode.Create, 0n);
        await expect(host.publish(stage, occupied)).rejects.toMatchObject({
            code: ConnectorHostErrorCode.AlreadyExists,
            definitive: true,
        });
        expect((await host.read(occupied, 0n, 32)).bytes).toEqual(Buffer.from('preserved'));
        expect((await host.read(stage, 0n, expected.length, snapshot(metadata))).bytes).toEqual(
            expected,
        );
        await host.publish(stage, destination);
        await expect(host.stat(stage)).rejects.toThrow();
        const installed: HostFileMetadata = await host.stat(destination);
        expect(await host.digest(destination, snapshot(installed))).toMatchObject({
            digest: createHash('sha256').update(expected).digest('hex'),
            size: BigInt(expected.length),
        });
        const names: string[] = [];
        let pageOffset: number | null = 0;
        while (pageOffset !== null) {
            const page: HostDirectoryPage = await host.list('data é', pageOffset, 1);
            names.push(...page.entries.map((entry): string => entry.name));
            if (names.length > 2) {
                throw new Error('Directory page duplicated its cursor');
            }
            if (page.nextOffset !== null && page.nextOffset <= pageOffset) {
                throw new Error('Directory page made no cursor progress');
            }
            pageOffset = page.nextOffset;
        }
        expect(names.sort()).toEqual(['occupied.bin', 'published.bin']);
        await delay(25);
        const changed: Buffer = Buffer.from(expected);
        changed[0] = expected[0] === 255 ? 0 : 255;
        await host.write(destination, changed.subarray(0, 1), HostWriteMode.Update, 0n);
        await expect(host.read(destination, 0n, 32, snapshot(installed))).rejects.toMatchObject({
            code: 'snapshot-changed',
        });
        await expect(host.digest(destination, snapshot(installed))).rejects.toMatchObject({
            code: 'snapshot-changed',
        });
        fixture.allowed = false;
        try {
            await expect(host.read(destination, 0n, 32)).rejects.toThrow('revoked');
            await expect(
                host.write(destination, Buffer.from('must not replace'), HostWriteMode.Replace, 0n),
            ).rejects.toThrow('revoked');
        } finally {
            fixture.allowed = true;
        }
        expect((await host.read(destination, 0n, changed.length)).bytes).toEqual(changed);
        await host.remove('data é', true);
        await expect(host.stat(destination)).rejects.toThrow();
    },
    60000,
);

it.skipIf(process.platform !== 'win32' || process.env['NERVA_WINDOWS_WORKSPACE_SMOKE'] !== '1')(
    'actual Windows cmd search and native Node file reads preserve text, tail and binary output',
    async (): Promise<void> => {
        await using fixture: WindowsWorkspaceFixture = await WindowsWorkspaceFixture.create();
        const text: Buffer = Buffer.from('first\r\nneedle alpha\r\nlast\r\n');
        await fixture.host.write('input.txt', text, HostWriteMode.Create, 0n);
        const searched: WindowsWorkspaceCommand = await fixture.execute(
            command(
                null,
                [],
                HostShell.Cmd,
                'type input.txt && findstr /n /l /c:"needle" input.txt',
            ),
        );
        expect(searched.snapshot).toMatchObject({
            exitCode: 0,
            signal: null,
            failure: null,
            running: false,
            treeRunning: false,
            outputComplete: true,
        });
        expect(searched.stdout).toEqual(Buffer.concat([text, Buffer.from('2:needle alpha\r\n')]));
        expect(searched.stderr).toEqual(Buffer.alloc(0));
        const binary: Buffer = Buffer.alloc(65539);
        for (let index: number = 0; index < binary.length; index++) {
            binary[index] = index % 256;
        }
        await fixture.host.write('binary.bin', binary, HostWriteMode.Create, 0n);
        await fixture.host.write(
            'unicode.txt',
            Buffer.from('first\r\nneedle é\r\nlast 𝄞\r\n'),
            HostWriteMode.Create,
            0n,
        );
        const source: string =
            "const fs=require('node:fs');process.stdout.write(fs.readFileSync(process.argv[1]));const rows=fs.readFileSync(process.argv[2],'utf8').split('\\r\\n');process.stderr.write(rows.at(-2)+'\\r\\n');";
        const read: WindowsWorkspaceCommand = await fixture.execute(
            command(process.execPath, ['-e', source, 'binary.bin', 'unicode.txt'], null, null),
        );
        expect(read.snapshot).toMatchObject({
            exitCode: 0,
            signal: null,
            failure: null,
            running: false,
            treeRunning: false,
            outputComplete: true,
        });
        expect(read.stdout).toEqual(binary);
        expect(read.stderr).toEqual(Buffer.from('last 𝄞\r\n'));
    },
    60000,
);

it.skipIf(process.platform !== 'win32' || process.env['NERVA_WINDOWS_WORKSPACE_SMOKE'] !== '1')(
    'actual Windows environment inspection finds cmd and node through PATHEXT without searching the workspace',
    async (): Promise<void> => {
        await using fixture: WindowsWorkspaceFixture = await WindowsWorkspaceFixture.create();
        const decoy: string = 'nerva-workspace-only-' + process.pid.toString();
        await fixture.host.write(decoy + '.exe', Buffer.alloc(0), HostWriteMode.Create, 0n);
        await fixture.host.write(decoy + '.cmd', Buffer.alloc(0), HostWriteMode.Create, 0n);
        const report: HostEnvironmentReport = await fixture.host.inspectEnvironment({
            programs: [
                'cmd',
                'node',
                'CMD.EXE',
                'Node.Exe',
                decoy,
                decoy + '.exe',
                'nerva-absent-7d1f',
            ],
            variables: ['PATH', 'Path', 'pathext', 'SystemRoot', 'NERVA_ENVIRONMENT_ABSENT_7D1F'],
        });
        expect(report).toEqual({
            platform: 'windows',
            programs: [true, true, true, true, false, false, false],
            variables: [true, true, true, true, false],
        });
        const tools: HostMcpWorkspaceTools = new HostMcpWorkspaceTools(
            fixture.host,
            new AbortController().signal,
        );
        expect(
            JSON.parse(
                await tools.call('environment_inspect', {
                    programs: ['cmd', 'nerva-absent-7d1f'],
                    variables: ['ComSpec'],
                }),
            ),
        ).toEqual({ platform: 'windows', programs: [true, false], variables: [true] });
        await expect(
            tools.call('environment_inspect', { programs: ['C:\\Windows\\cmd'], variables: [] }),
        ).rejects.toMatchObject({ code: ConnectorHostErrorCode.InvalidRequest, definitive: true });
        fixture.allowed = false;
        try {
            await expect(
                fixture.host.inspectEnvironment({ programs: ['cmd'], variables: [] }),
            ).rejects.toThrow('revoked');
        } finally {
            fixture.allowed = true;
        }
    },
    60000,
);
