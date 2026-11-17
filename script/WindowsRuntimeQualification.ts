// SPDX-FileCopyrightText: 2026 Nerva contributors
// SPDX-License-Identifier: LicenseRef-Proprietary

import { createReadStream } from 'node:fs';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Boundary } from 'nerva-connector-protocol/protocol/Boundary.js';

/** A successful CI report proves these existing Windows cases ran rather than being filtered or skipped. */
export interface WindowsRuntimeQualificationSummary {
    readonly platform: NodeJS.Platform;
    readonly suites: number;
    readonly passed: number;
    readonly skipped: number;
}

/** Validates the finite state, workspace, environment, process, ConPTY, HTTP and stdio MCP qualification matrix. */
export class WindowsRuntimeQualification {
    /** Every selected suite must run completely on the actual Windows runner. */
    public static readonly suites: Readonly<Record<string, number>> = {
        'WindowsStateOwner.test.ts': 2,
        'PairedStateMigration.test.ts': 2,
        'ConnectorLogout.test.ts': 6,
        'HostProcessLaunch.test.ts': 4,
        'HostProcessLifetime.test.ts': 6,
        'WindowsHostTerminal.real.test.ts': 2,
        'HostHttp.test.ts': 12,
        'WindowsHostMcp.real.test.ts': 1,
        'WindowsHostWorkspace.real.test.ts': 3,
    };

    /** These assertions exercise actual native owners, ConPTY, isolated IP-pinned TLS and persistent stdio MCP. */
    public static readonly nativeCases: Readonly<Record<string, readonly string[]>> = {
        'HostProcessLaunch.test.ts': [
            'Windows native creation acknowledges absolute and PATH executables and preserves literal arguments',
            'Windows missing and invalid executable failures are definitive only after native no-create cleanup',
        ],
        'HostProcessLifetime.test.ts': [
            'Windows keeps a launcher-descendant job alive after root exit and observes its eventual empty state',
            'Windows stop confirms the remaining GUI-style descendant job is empty while preserving the root exit',
        ],
        'WindowsHostTerminal.real.test.ts': [
            'actual ConPTY preserves native terminal bytes, input acceptance, geometry and verified Job shutdown',
            'a ConPTY root exit keeps its live detached descendant under the same Job until explicit stop',
        ],
        'HostHttp.test.ts': [
            'pins an actual TLS connection while preserving Host and body bytes through bounded native pulls',
            'retains certificate hostname validation even when its root and pinned IP are trusted',
            'preserves representation length for bodyless HEAD responses with status 200',
            'preserves representation length for bodyless GET responses with status 304',
            'exposes redirects without following them or opening a second connection',
            'still refuses a GET representation whose declared body exceeds its admitted byte ceiling',
            'preserves the exact last committed window and rejects a changed cursor',
            'a failed HTTP body never becomes a successful empty EOF',
            'bounds an unknown-length body and keeps overflow distinct from completed input',
            'rejects implicit authentication, proxy headers and nonliteral addresses before opening a socket',
            'cancels and joins a real connection before headers settle',
            'expires abandoned transfers after their finite lifetime and returns capacity only after cleanup',
        ],
        'WindowsHostMcp.real.test.ts': [
            'actual Windows cmd.exe standard MCP config preserves environment, persistent stdio and verified Job EOF release',
        ],
        'WindowsHostWorkspace.real.test.ts': [
            'actual Windows host workspace preserves binary files, snapshots, digest and atomic publication',
            'actual Windows cmd search and native Node file reads preserve text, tail and binary output',
            'actual Windows environment inspection finds cmd and node through PATHEXT without searching the workspace',
        ],
    };

    /** Synthetic or skipped reports never establish native runtime qualification. */
    public static read(
        raw: unknown,
        platform: NodeJS.Platform,
    ): WindowsRuntimeQualificationSummary {
        const expected: number = Object.values(this.suites).reduce(
            (total: number, count: number): number => total + count,
            0,
        );
        if (
            platform !== 'win32' ||
            this.#field(raw, 'success') !== true ||
            Boundary.count(this.#field(raw, 'numFailedTests'), expected) !== 0 ||
            Boundary.count(this.#field(raw, 'numPendingTests'), expected) !== 0 ||
            Boundary.count(this.#field(raw, 'numPassedTests'), expected) !== expected
        ) {
            throw new Error('Windows runtime qualification requires every selected case to pass');
        }
        const results: readonly unknown[] = Boundary.array(
            this.#field(raw, 'testResults'),
            Object.keys(this.suites).length,
        );
        const files: Set<string> = new Set();
        const names: Set<string> = new Set();
        let passed: number = 0;
        for (const result of results) {
            const path: unknown = this.#field(result, 'name');
            if (typeof path !== 'string' || path.length > 4096) {
                throw new Error('Invalid Windows runtime qualification suite');
            }
            const file: string | undefined = path.replaceAll('\\', '/').split('/').at(-1);
            const count: number | undefined = file === undefined ? undefined : this.suites[file];
            if (
                file === undefined ||
                !Object.hasOwn(this.suites, file) ||
                count === undefined ||
                files.has(file)
            ) {
                throw new Error('Unexpected or duplicate Windows runtime qualification suite');
            }
            const assertions: readonly unknown[] = Boundary.array(
                this.#field(result, 'assertionResults'),
                count,
            );
            if (assertions.length !== count) {
                throw new Error('Windows runtime qualification suite is incomplete');
            }
            const suiteNames: Set<string> = new Set();
            for (const assertion of assertions) {
                const name: unknown = this.#field(assertion, 'fullName');
                if (
                    typeof name !== 'string' ||
                    name.length < 1 ||
                    name.length > 2048 ||
                    names.has(name) ||
                    this.#field(assertion, 'status') !== 'passed'
                ) {
                    throw new Error('Windows runtime qualification contains an unpassed case');
                }
                names.add(name);
                suiteNames.add(name);
                passed += 1;
            }
            if (
                (this.nativeCases[file] ?? []).some(
                    (name: string): boolean => !suiteNames.has(name),
                )
            ) {
                throw new Error('Required Windows native runtime cases did not run');
            }
            files.add(file);
        }
        if (files.size !== Object.keys(this.suites).length || passed !== expected) {
            throw new Error('Required Windows native runtime cases did not run');
        }
        return { platform, suites: files.size, passed, skipped: 0 };
    }

    /** Reads one stable CI output with a finite byte budget and never creates another report or build tree. */
    public static async main(): Promise<void> {
        if (process.argv.length !== 3 || process.argv[2] === undefined) {
            throw new Error('Expected one Windows runtime qualification report');
        }
        const chunks: Buffer[] = [];
        let size: number = 0;
        const source: AsyncIterable<unknown> = createReadStream(process.argv[2], {
            highWaterMark: 65536,
        });
        for await (const chunk of source) {
            if (!(chunk instanceof Buffer) || size + chunk.length > 1048576) {
                throw new Error('Windows runtime qualification report exceeds its byte bound');
            }
            size += chunk.length;
            chunks.push(chunk);
        }
        const raw: unknown = JSON.parse(Buffer.concat(chunks, size).toString('utf8'));
        console.log(JSON.stringify(this.read(raw, process.platform)));
    }

    static #field(raw: unknown, name: string): unknown {
        if (
            raw === null ||
            typeof raw !== 'object' ||
            Array.isArray(raw) ||
            Object.getPrototypeOf(raw) !== Object.prototype
        ) {
            throw new Error('Invalid Windows runtime qualification report');
        }
        const descriptor: PropertyDescriptor | undefined = Object.getOwnPropertyDescriptor(
            raw,
            name,
        );
        if (descriptor === undefined || !Object.hasOwn(descriptor, 'value')) {
            throw new Error('Missing Windows runtime qualification report field');
        }
        return descriptor.value;
    }
}

if (process.argv[1] !== undefined && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
    try {
        await WindowsRuntimeQualification.main();
    } catch {
        console.error('Windows runtime qualification is incomplete or its report is invalid');
        process.exitCode = 1;
    }
}
