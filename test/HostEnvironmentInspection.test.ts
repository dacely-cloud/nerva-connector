// SPDX-FileCopyrightText: 2026 Nerva contributors
// SPDX-License-Identifier: LicenseRef-Proprietary

import { join, relative } from 'node:path';
import { expect, it } from 'vitest';
import { HostEnvironmentInspection } from '../src/host/HostEnvironmentInspection.js';
import { HostEnvironmentValidation } from '../src/host/HostEnvironmentValidation.js';
import type { HostEnvironmentReport } from '../src/host/HostEnvironmentTypes.js';
import { ConnectorHostErrorCode, ConnectorHostPlatform } from '../src/protocol/ConnectorHost.js';
import {
    HostEnvironmentFixture,
    type HostEnvironmentFixtureSource,
} from './support/HostEnvironmentFixture.js';

/** One inspection against an injected platform and environment with an unaborted signal. */
async function inspect(
    source: HostEnvironmentFixtureSource,
    programs: readonly string[],
    variables: readonly string[] = [],
): Promise<HostEnvironmentReport> {
    return await new HostEnvironmentInspection(source).inspect(
        { programs, variables },
        new AbortController().signal,
    );
}

it.skipIf(process.platform !== 'linux')(
    'POSIX inspection requires executable regular files on absolute PATH entries and never searches the current directory',
    async (): Promise<void> => {
        await using fixture: HostEnvironmentFixture = await HostEnvironmentFixture.create();
        const first: string = await fixture.directory('first');
        const second: string = await fixture.directory('second');
        const local: string = await fixture.directory('relative');
        const quoted: string = await fixture.directory('quoted');
        const executable: string = await fixture.file(first, 'tool-exec', 0o755);
        const plain: string = await fixture.file(first, 'tool-plain', 0o644);
        await fixture.directory(join('first', 'tool-dir'));
        await fixture.link(first, 'tool-link', executable);
        await fixture.link(first, 'tool-link-plain', plain);
        await fixture.link(first, 'tool-dangling', join(fixture.root, 'missing-target'));
        await fixture.file(second, 'tool-later', 0o700);
        await fixture.file(local, 'tool-relative', 0o755);
        await fixture.file(quoted, 'tool-quoted', 0o755);
        const path: string = [
            '',
            first,
            '',
            relative(process.cwd(), local),
            '"' + quoted + '"',
            join(fixture.root, 'missing-directory'),
            plain,
            second,
            first,
            '',
        ].join(':');
        const source: HostEnvironmentFixtureSource = fixture.source(ConnectorHostPlatform.Linux, {
            PATH: path,
            PRESENT: 'value',
            EMPTY: '',
        });
        expect(
            await inspect(
                source,
                [
                    'tool-exec',
                    'tool-plain',
                    'tool-dir',
                    'tool-link',
                    'tool-link-plain',
                    'tool-dangling',
                    'tool-later',
                    'tool-relative',
                    'tool-quoted',
                    'tool-absent',
                ],
                ['PRESENT', 'EMPTY', 'ABSENT', 'present'],
            ),
        ).toEqual({
            platform: 'linux',
            programs: [true, false, false, true, false, false, true, false, false, false],
            variables: [true, false, false, false],
        });
        expect(source.lookups).toEqual(['PRESENT', 'EMPTY', 'ABSENT', 'present', 'PATH']);
        const mac: HostEnvironmentFixtureSource = fixture.source(ConnectorHostPlatform.MacOs, {
            PATH: second,
        });
        expect(await inspect(mac, ['tool-later', 'tool-exec'])).toEqual({
            platform: 'macos',
            programs: [true, false],
            variables: [],
        });
    },
);

it.skipIf(process.platform !== 'linux')(
    'Windows semantics strip one quote pair, ignore empty or relative entries and require absolute directories',
    async (): Promise<void> => {
        await using fixture: HostEnvironmentFixture = await HostEnvironmentFixture.create();
        const quoted: string = await fixture.directory('quoted dir');
        const local: string = await fixture.directory('local');
        await fixture.file(quoted, 'q.EXE', 0o644);
        await fixture.file(local, 'r.EXE', 0o644);
        const windows: (path: string) => HostEnvironmentFixtureSource = (
            path: string,
        ): HostEnvironmentFixtureSource =>
            fixture.source(ConnectorHostPlatform.Windows, { Path: path, PATHEXT: '.EXE' });
        expect(await inspect(windows(';;"' + quoted + '";;'), ['q'])).toEqual({
            platform: 'windows',
            programs: [true],
            variables: [],
        });
        expect((await inspect(windows('""' + quoted + '""'), ['q'])).programs).toEqual([false]);
        expect((await inspect(windows('"' + quoted), ['q'])).programs).toEqual([false]);
        expect(
            (await inspect(windows(';' + relative(process.cwd(), local) + ';;'), ['r'])).programs,
        ).toEqual([false]);
        expect((await inspect(windows(quoted + ':' + local), ['q', 'r'])).programs).toEqual([
            false,
            false,
        ]);
        expect(
            (await inspect(windows(''), ['q'], ['path', 'PATHEXT', 'Missing'])).variables,
        ).toEqual([false, true, false]);
        expect(
            (await inspect(windows(quoted), [], ['path', 'PATH', 'pathext', 'Missing'])).variables,
        ).toEqual([true, true, true, false]);
    },
);

it.skipIf(process.platform !== 'linux')(
    'Windows PATHEXT keeps order and its 32-extension bound, defaults when unset or empty and matches existing extensions case-insensitively',
    async (): Promise<void> => {
        await using fixture: HostEnvironmentFixture = await HostEnvironmentFixture.create();
        const bin: string = await fixture.directory('bin');
        const extensions: readonly string[] = Array.from(
            { length: 33 },
            (_value: unknown, index: number): string => '.X' + String(index + 1).padStart(2, '0'),
        );
        await fixture.directory(join('bin', 'esc'));
        await fixture.file(join(bin, 'esc'), 'payload', 0o644);
        for (const name of [
            'limit.X32',
            'over.X33',
            'd.CMD',
            'p.PS1',
            'node.exe.EXE',
            'Tool.Exe',
            'script.py',
            'mixed.exe.EXE',
            'cased.Ps1',
        ]) {
            await fixture.file(bin, name, 0o644);
        }
        const source: (pathext: string | null) => HostEnvironmentFixtureSource = (
            pathext: string | null,
        ): HostEnvironmentFixtureSource =>
            fixture.source(
                ConnectorHostPlatform.Windows,
                pathext === null ? { PATH: bin } : { PATH: bin, PATHEXT: pathext },
            );
        expect(
            (await inspect(source(';;' + extensions.join(';') + ';'), ['limit', 'over'])).programs,
        ).toEqual([true, false]);
        for (const unset of [null, '']) {
            expect((await inspect(source(unset), ['d', 'p'])).programs).toEqual([true, false]);
        }
        expect((await inspect(source('.PS1'), ['d', 'p'])).programs).toEqual([false, true]);
        expect(
            (await inspect(source('.EXE;.CMD'), ['node.exe', 'Tool.Exe', 'script.py', 'mixed.exe']))
                .programs,
        ).toEqual([false, true, false, false]);
        expect((await inspect(source('.EXE;.PY'), ['script.py'])).programs).toEqual([true]);
        expect((await inspect(source('.ps1'), ['cased'])).programs).toEqual([false]);
        expect((await inspect(source('.Ps1'), ['cased'])).programs).toEqual([true]);
        expect((await inspect(source('.EXE;/payload;\\payload'), ['esc'])).programs).toEqual([
            false,
        ]);
    },
);

it.skipIf(process.platform !== 'linux')(
    'Windows counts unfollowable alias entries but never directories, while POSIX requires a followed executable',
    async (): Promise<void> => {
        await using fixture: HostEnvironmentFixture = await HostEnvironmentFixture.create();
        const apps: string = await fixture.directory('WindowsApps');
        const target: string = await fixture.directory('target');
        await fixture.link(apps, 'alias.exe', join(fixture.root, 'uninstalled', 'alias.exe'));
        await fixture.directory(join('WindowsApps', 'folder.exe'));
        await fixture.link(apps, 'dirlink.exe', target);
        const regular: string = await fixture.file(target, 'real.exe', 0o644);
        await fixture.link(apps, 'filelink.exe', regular);
        const programs: readonly string[] = ['alias', 'folder', 'dirlink', 'filelink', 'real'];
        expect(
            (
                await inspect(
                    fixture.source(ConnectorHostPlatform.Windows, { PATH: apps, PATHEXT: '.exe' }),
                    programs,
                )
            ).programs,
        ).toEqual([true, false, false, true, false]);
        expect(
            (
                await inspect(fixture.source(ConnectorHostPlatform.Linux, { PATH: apps }), [
                    'alias.exe',
                    'folder.exe',
                    'dirlink.exe',
                    'filelink.exe',
                ])
            ).programs,
        ).toEqual([false, false, false, false]);
    },
);

it.skipIf(process.platform !== 'linux')(
    'only the first 1024 PATH entries are considered',
    async (): Promise<void> => {
        await using fixture: HostEnvironmentFixture = await HostEnvironmentFixture.create();
        const bin: string = await fixture.directory('bin');
        await fixture.file(bin, 'bounded', 0o755);
        const missing: (count: number) => readonly string[] = (count: number): readonly string[] =>
            Array.from({ length: count }, (_value: unknown, index: number): string =>
                join(fixture.root, 'missing-' + String(index)),
            );
        for (const [count, found] of [
            [1023, true],
            [1024, false],
        ] as const) {
            const source: HostEnvironmentFixtureSource = fixture.source(
                ConnectorHostPlatform.Linux,
                { PATH: [...missing(count), bin].join(':') },
            );
            expect((await inspect(source, ['bounded'])).programs).toEqual([found]);
        }
    },
);

/** Structural, character, uniqueness and size violations share one definitive invalid-request outcome. */
const rejected: readonly (readonly [string, unknown, unknown])[] = [
    ['missing programs', undefined, []],
    ['non-array variables', [], 'PATH'],
    ['non-string program', [5], []],
    ['non-string variable', [], [null]],
    [
        'too many programs',
        Array.from(
            { length: 257 },
            (_value: unknown, index: number): string => 'p' + String(index),
        ),
        [],
    ],
    [
        'too many variables',
        [],
        Array.from(
            { length: 257 },
            (_value: unknown, index: number): string => 'V' + String(index),
        ),
    ],
    ['empty program', [''], []],
    ['current directory', ['.'], []],
    ['parent directory', ['..'], []],
    ['POSIX separator', ['bin/node'], []],
    ['Windows separator', ['bin\\node'], []],
    ['NUL program', ['no\0de'], []],
    ['duplicate program', ['node', 'node'], []],
    ['256 code points', ['\u{1D11E}'.repeat(256)], []],
    ['lone surrogate', ['node\uD800'], []],
    ['empty variable', [], ['']],
    ['assignment variable', [], ['A=B']],
    ['NUL variable', [], ['A\0B']],
    ['duplicate variable', [], ['PATH', 'PATH']],
    ['oversized variable', [], ['V'.repeat(256)]],
];

/** Capture a synchronous rejection for exact code and certainty assertions. */
function failure(action: () => unknown): unknown {
    try {
        action();
    } catch (caught: unknown) {
        return caught;
    }
    throw new Error('Expected a definitive rejection');
}

it.each(rejected)(
    'validation rejects %s definitively',
    (_label: string, programs: unknown, variables: unknown): void => {
        expect(
            failure((): unknown => HostEnvironmentValidation.request(programs, variables)),
        ).toMatchObject({
            code: ConnectorHostErrorCode.InvalidRequest,
            definitive: true,
        });
    },
);

it('typed inspection callers are validated again before any environment or filesystem access', async (): Promise<void> => {
    await using fixture: HostEnvironmentFixture = await HostEnvironmentFixture.create();
    const source: HostEnvironmentFixtureSource = fixture.source(ConnectorHostPlatform.Linux, {
        PATH: fixture.root,
    });
    for (const [programs, variables] of [
        [['node', 'node'], []],
        [['..'], []],
        [[], ['A=B']],
    ] as const) {
        await expect(inspect(source, programs, variables)).rejects.toMatchObject({
            code: ConnectorHostErrorCode.InvalidRequest,
            definitive: true,
        });
    }
    expect(source.lookups).toEqual([]);
});

it('accepts the exact name, count and code-point bounds and skips PATH when no program is requested', async (): Promise<void> => {
    await using fixture: HostEnvironmentFixture = await HostEnvironmentFixture.create();
    const source: HostEnvironmentFixtureSource = fixture.source(ConnectorHostPlatform.Linux, {
        PATH: fixture.root,
    });
    const variables: readonly string[] = Array.from(
        { length: 256 },
        (_value: unknown, index: number): string =>
            'V'.repeat(255 - String(index).length) + String(index),
    );
    expect(await inspect(source, [], variables)).toEqual({
        platform: 'linux',
        programs: [],
        variables: Array.from({ length: 256 }, (): boolean => false),
    });
    expect(source.lookups).toEqual(variables);
    const programs: readonly string[] = [
        '𝄞'.repeat(255),
        'p'.repeat(255),
        ...Array.from(
            { length: 254 },
            (_value: unknown, index: number): string => 'n' + String(index),
        ),
    ];
    expect((await inspect(source, programs)).programs).toEqual(
        Array.from({ length: 256 }, (): boolean => false),
    );
});

it('cancellation is honored before reading variables and between filesystem probes', async (): Promise<void> => {
    await using fixture: HostEnvironmentFixture = await HostEnvironmentFixture.create();
    const before: AbortController = new AbortController();
    const reason: Error = new Error('inspection canceled');
    before.abort(reason);
    const unread: HostEnvironmentFixtureSource = fixture.source(ConnectorHostPlatform.Linux, {
        PATH: fixture.root,
    });
    await expect(
        new HostEnvironmentInspection(unread).inspect(
            { programs: ['node'], variables: ['PATH'] },
            before.signal,
        ),
    ).rejects.toBe(reason);
    expect(unread.lookups).toEqual([]);
    const during: AbortController = new AbortController();
    const base: HostEnvironmentFixtureSource = fixture.source(ConnectorHostPlatform.Linux, {
        PATH: Array.from({ length: 64 }, (_value: unknown, index: number): string =>
            join(fixture.root, 'missing-' + String(index)),
        ).join(':'),
    });
    await expect(
        new HostEnvironmentInspection({
            platform: base.platform,
            variable: (name: string): string | undefined => {
                const value: string | undefined = base.variable(name);
                if (name === 'PATH') {
                    during.abort(reason);
                }
                return value;
            },
        }).inspect({ programs: ['node'], variables: [] }, during.signal),
    ).rejects.toBe(reason);
});

it('the runtime source maps supported platforms and rejects others before inspection', async (): Promise<void> => {
    expect(failure((): unknown => HostEnvironmentInspection.runtime('freebsd'))).toMatchObject({
        code: ConnectorHostErrorCode.Unsupported,
        definitive: true,
    });
    const report: HostEnvironmentReport = await HostEnvironmentInspection.runtime().inspect(
        { programs: [], variables: ['PATH', 'NERVA_ENVIRONMENT_INSPECTION_ABSENT'] },
        new AbortController().signal,
    );
    expect(report).toEqual({
        platform:
            process.platform === 'win32'
                ? 'windows'
                : process.platform === 'darwin'
                  ? 'macos'
                  : 'linux',
        programs: [],
        variables: [true, false],
    });
});
