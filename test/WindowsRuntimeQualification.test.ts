// SPDX-FileCopyrightText: 2026 Nerva contributors
// SPDX-License-Identifier: LicenseRef-Proprietary

import { expect, it } from 'vitest';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';
import { WindowsRuntimeQualification } from '../script/WindowsRuntimeQualification.js';

/** Only reporter fields consumed by the gate are modeled; this fixture makes no native execution claim. */
interface QualificationCase {
    readonly fullName: string;
    readonly status: string;
}
interface QualificationSuite {
    readonly name: string;
    readonly assertionResults: readonly QualificationCase[];
}
interface QualificationReport {
    readonly success: boolean;
    readonly numFailedTests: number;
    readonly numPendingTests: number;
    readonly numPassedTests: number;
    readonly testResults: readonly QualificationSuite[];
}

/** A structurally valid report still requires the actual Windows platform at the executable entry point. */
function report(): QualificationReport {
    let index: number = 0;
    const suites: readonly QualificationSuite[] = Object.entries(
        WindowsRuntimeQualification.suites,
    ).map(([name, count]: [string, number]): QualificationSuite => {
        const names: readonly string[] = WindowsRuntimeQualification.nativeCases[name] ?? [];
        const assertions: QualificationCase[] = [];
        for (let caseIndex: number = 0; caseIndex < count; caseIndex += 1) {
            const fullName: string = names[caseIndex] ?? 'other required case ' + index.toString();
            index += 1;
            assertions.push({ fullName, status: 'passed' });
        }
        return {
            name: 'C:\\fixture\\test\\' + name,
            assertionResults: assertions,
        };
    });
    return {
        success: true,
        numFailedTests: 0,
        numPendingTests: 0,
        numPassedTests: index,
        testResults: suites,
    };
}

it('requires the complete finite Windows report and every actual workspace, environment, process, ConPTY, HTTP and MCP case', (): void => {
    expect(WindowsRuntimeQualification.read(report(), 'win32')).toEqual({
        platform: 'win32',
        suites: 10,
        passed: 40,
        skipped: 0,
    });
    expect((): void => {
        WindowsRuntimeQualification.read(report(), 'linux');
    }).toThrow();
});

it('rejects skipped, failed, missing and duplicate suites even if the report claims success', (): void => {
    const valid: QualificationReport = report();
    const first: QualificationSuite | undefined = valid.testResults[0];
    if (first === undefined) {
        throw new Error('Missing fixture suite');
    }
    for (const raw of [
        { ...valid, success: false },
        { ...valid, numPendingTests: 1 },
        { ...valid, numFailedTests: 1 },
        { ...valid, numPassedTests: 37 },
        { ...valid, numPassedTests: Number.MAX_SAFE_INTEGER + 1 },
        { ...valid, testResults: valid.testResults.slice(1) },
        {
            ...valid,
            testResults: [first, ...valid.testResults.slice(0, valid.testResults.length - 1)],
        },
    ]) {
        expect((): void => {
            WindowsRuntimeQualification.read(raw, 'win32');
        }).toThrow();
    }
});

it('rejects the former 22-case matrix and a missing or truncated HTTP suite', (): void => {
    const valid: QualificationReport = report();
    const withoutHttp: readonly QualificationSuite[] = valid.testResults.filter(
        (suite: QualificationSuite): boolean => !suite.name.endsWith('HostHttp.test.ts'),
    );
    const legacy: readonly QualificationSuite[] = withoutHttp.filter(
        (suite: QualificationSuite): boolean =>
            !suite.name.endsWith('WindowsHostMcp.real.test.ts') &&
            !suite.name.endsWith('WindowsHostWorkspace.real.test.ts'),
    );
    expect(WindowsRuntimeQualification.nativeCases['HostHttp.test.ts']).toHaveLength(12);
    for (const raw of [
        { ...valid, numPassedTests: 22, testResults: legacy },
        { ...valid, testResults: withoutHttp },
        {
            ...valid,
            testResults: valid.testResults.map((suite: QualificationSuite): QualificationSuite =>
                !suite.name.endsWith('HostHttp.test.ts')
                    ? suite
                    : { ...suite, assertionResults: suite.assertionResults.slice(0, 11) },
            ),
        },
    ]) {
        expect((): void => {
            WindowsRuntimeQualification.read(raw, 'win32');
        }).toThrow();
    }
});

it.each(Object.entries(WindowsRuntimeQualification.nativeCases))(
    'rejects every skipped or substituted required native assertion in %s',
    (file: string, required: readonly string[]): void => {
        const valid: QualificationReport = report();
        for (let index: number = 0; index < required.length; index += 1) {
            for (const skipped of [true, false]) {
                const suites: readonly QualificationSuite[] = valid.testResults.map(
                    (suite: QualificationSuite): QualificationSuite =>
                        !suite.name.endsWith(file)
                            ? suite
                            : {
                                  ...suite,
                                  assertionResults: suite.assertionResults.map(
                                      (
                                          assertion: QualificationCase,
                                          position: number,
                                      ): QualificationCase =>
                                          position !== index
                                              ? assertion
                                              : skipped
                                                ? { ...assertion, status: 'pending' }
                                                : {
                                                      ...assertion,
                                                      fullName: 'replacement non-native assertion',
                                                  },
                                  ),
                              },
                );
                expect((): void => {
                    WindowsRuntimeQualification.read({ ...valid, testResults: suites }, 'win32');
                }).toThrow();
            }
        }
    },
);

it.each(Object.entries(WindowsRuntimeQualification.suites))(
    'rejects a missing required suite %s even when aggregate counters are changed',
    (file: string, count: number): void => {
        const valid: QualificationReport = report();
        const suites: readonly QualificationSuite[] = valid.testResults.filter(
            (suite: QualificationSuite): boolean => !suite.name.endsWith(file),
        );
        for (const passed of [valid.numPassedTests, valid.numPassedTests - count]) {
            expect((): void => {
                WindowsRuntimeQualification.read(
                    { ...valid, numPassedTests: passed, testResults: suites },
                    'win32',
                );
            }).toThrow();
        }
    },
);

it('the Node source entry point loads without a runtime compiler and rejects missing reports', async (): Promise<void> => {
    await expect(
        promisify(execFile)(
            process.execPath,
            [fileURLToPath(new URL('../script/WindowsRuntimeQualification.ts', import.meta.url))],
            { timeout: 5000, maxBuffer: 1024, env: { PATH: process.env['PATH'] } },
        ),
    ).rejects.toMatchObject({
        code: 1,
        stdout: '',
        stderr: 'Windows runtime qualification is incomplete or its report is invalid\n',
    });
});
