// SPDX-FileCopyrightText: 2026 Nerva contributors
// SPDX-License-Identifier: LicenseRef-Proprietary

import { spawn, type ChildProcess } from 'node:child_process';
import { createHash, randomBytes } from 'node:crypto';
import {
    lstat,
    mkdir,
    open,
    readFile,
    readdir,
    rename,
    writeFile,
    type FileHandle,
} from 'node:fs/promises';
import type { BigIntStats } from 'node:fs';
import { basename, dirname, join, resolve } from 'node:path';
import { Boundary } from 'nerva-connector-protocol/protocol/Boundary.js';
import { ProtectedFiles } from '../../src/local/ProtectedFiles.js';
import { ConnectorClientFiles } from '../../src/runtime/ConnectorClientFiles.js';
import { ConnectorFilesystem } from '../../src/runtime/ConnectorFilesystem.js';
import { ConnectorOperationJournal } from '../../src/runtime/ConnectorOperationJournal.js';
import { ConnectorJournalStore } from '../../src/runtime/ConnectorJournalStore.js';
import { ConnectorFileJournalCodec } from '../../src/runtime/ConnectorFileJournalCodec.js';
import {
    ConnectorEffectKind,
    type ConnectorCapturedFileEffect,
} from '../../src/runtime/ConnectorEffectContext.js';
import type { ConnectorJournalPending } from '../../src/runtime/ConnectorJournalState.js';
import {
    ConnectorFileFailure,
    type ConnectorFileResponse,
} from 'nerva-connector-protocol/protocol/ConnectorFiles.js';
import type {
    ConnectorFileOperation,
    ConnectorFilePermit,
    ConnectorFileCompletion,
} from 'nerva-connector-protocol/protocol/ConnectorFileJobs.js';
import { ConnectorFileJobsCodec } from 'nerva-connector-protocol/protocol/ConnectorFileJobsCodec.js';
import { ConnectorFileProof } from '../../src/runtime/ConnectorFileProof.js';
import {
    ConnectorAuthorizationKind,
    type ConnectorAuthorization,
} from 'nerva-connector-protocol/protocol/ConnectorAuthorization.js';
import { ConnectorAuthorizationProof } from '../../src/protocol/ConnectorAuthorizationProof.js';
import { ConnectorAdmissionMigrationProof } from '../../src/protocol/ConnectorAdmissionMigrationProof.js';
import { ConnectorMigrationPlanCodec } from 'nerva-connector-protocol/protocol/ConnectorMigrationPlanCodec.js';
import { ConnectorMigrationApprovalCodec } from 'nerva-connector-protocol/protocol/ConnectorMigrationApprovalCodec.js';
import {
    ConnectorMigrationLane,
    type ConnectorMigrationPlan,
    type ConnectorMigrationSource,
    type ConnectorMigrationApproval,
    type ConnectorMigrationExpected,
} from 'nerva-connector-protocol/protocol/ConnectorAdmissionMigration.js';

import { CapturedEffectsFixture, type CapturedOriginal } from './CapturedEffectsFixture.js';
import {
    OriginalJournalFixtureCodec,
    type OriginalJournalFixtureSnapshot,
} from './OriginalJournalFixtureCodec.js';

/** Fixed labels reveal no generated identity, native descriptor, path, key, or operation content. */
enum QualificationCase {
    Input = 'input',
    Fresh = 'fresh-captured-write',
    Started = 'captured-started-recovery',
    Root = 'replaced-root-refusal',
    Staging = 'replaced-staging-refusal',
    Pinned = 'pinned-renamed-root',
    Terminal = 'terminal-replay',
    Migration = 'product-history-migration',
    Preparation = 'product-policy-preparation',
}

/** The probe invokes only explicit non-network product maintenance commands, including stopped plan preparation. */
enum QualificationCommand {
    PrepareMigration = 'prepare-history-migration',
    Migration = 'migrate-history',
    Preparation = 'prepare-policy-change',
}

/** Controller-selected paths remain private input; nothing is inferred from HOME or a network response. */
interface QualificationSettings {
    readonly directory: string;
    readonly application: string;
}

/** This complete public receipt is finite and contains only fixed labels and booleans. */
interface QualificationReport {
    readonly passed: boolean;
    readonly cases: readonly QualificationCase[];
    readonly failed: QualificationCase | null;
    readonly sourcesRetained: true;
    readonly keysReleased: boolean;
}

/** Child JSON remains private and is narrowed before individual non-content assertions. */
interface QualificationCommandResult {
    readonly code: number | null;
    readonly body: Readonly<Record<string, unknown>>;
}

/** No assertion or exception can print a private value through this probe. */
function check(value: boolean): void {
    if (!value) {
        throw new Error('Qualification assertion failed');
    }
}

/** The existing frame is bounded before parsing and accepts exactly the two operator-selected fields. */
async function settings(): Promise<QualificationSettings> {
    const chunks: Buffer[] = [];
    let size: number = 0;
    const timeout: NodeJS.Timeout = setTimeout((): void => {
        process.stdin.destroy(new Error('Qualification input timeout'));
    }, 5000);
    try {
        const input: AsyncIterable<unknown> = process.stdin;
        for await (const chunk of input) {
            if (!(chunk instanceof Buffer) || chunk.byteLength > 8192 - size) {
                throw new Error('Qualification input exceeds bound');
            }
            chunks.push(chunk);
            size += chunk.byteLength;
        }
    } finally {
        clearTimeout(timeout);
    }
    const raw: unknown = JSON.parse(
        new TextDecoder('utf-8', { fatal: true }).decode(Buffer.concat(chunks, size)),
    );
    const value: Readonly<Record<string, unknown>> = Boundary.record(raw, [
        'directory',
        'application',
    ]);
    const directory: string = ProtectedFiles.path(value['directory']);
    const application: string = ProtectedFiles.path(value['application']);
    check(
        [directory, application].every(
            (path: string): boolean => resolve(path) === path && Buffer.byteLength(path) <= 4096,
        ),
    );
    await ProtectedFiles.directory(directory);
    const parent: BigIntStats = await lstat(directory, { bigint: true });
    check(
        parent.isDirectory() &&
            parent.uid === BigInt(process.getuid?.() ?? -1) &&
            (parent.mode & 0o777n) === 0o700n,
    );
    for (const path of [application]) {
        const status: BigIntStats = await lstat(path, { bigint: true });
        check(
            status.isFile() &&
                (status.uid === 0n || status.uid === parent.uid) &&
                (status.mode & 0o022n) === 0n,
        );
    }
    return { directory, application };
}

/** One finite local cohort retains artifacts for controller cleanup after all child/native owners have joined. */
class FileEffectQualification implements AsyncDisposable {
    readonly #node: FileHandle;
    #closed: boolean = false;
    readonly #fixtures: CapturedEffectsFixture[] = [];
    readonly #passed: QualificationCase[] = [];
    #current: QualificationCase = QualificationCase.Input;

    private constructor(
        public readonly input: QualificationSettings,
        node: FileHandle,
    ) {
        this.#node = node;
    }

    /** Pin the already running interpreter image through the kernel, without trusting an ambient executable pathname or owner. */
    public static async create(input: QualificationSettings): Promise<FileEffectQualification> {
        const node: FileHandle = await open('/proc/self/exe', 'r');
        try {
            const status: BigIntStats = await node.stat({ bigint: true });
            check(status.isFile() && (status.mode & 0o111n) !== 0n);
            return new FileEffectQualification(input, node);
        } catch (caught: unknown) {
            await node.close();
            throw caught;
        }
    }

    /** All product commands have joined before the sole retained interpreter descriptor is released. */
    public async [Symbol.asyncDispose](): Promise<void> {
        if (!this.#closed) {
            this.#closed = true;
            await this.#node.close();
        }
    }

    /** Generated keys are erased after the last nested owner exits on both success and failure. */
    public async run(): Promise<QualificationReport> {
        let passed: boolean = false;
        try {
            for (const selected of Object.values(QualificationCase)) {
                if (selected === QualificationCase.Input) {
                    continue;
                }
                this.#current = selected;
                await this.#case(selected);
                this.#passed.push(selected);
            }
            passed = true;
        } catch {
            passed = false;
        } finally {
            for (const fixture of this.#fixtures) {
                fixture.history.identity.key[Symbol.dispose]();
            }
        }
        return {
            passed,
            cases: this.#passed,
            failed: passed ? null : this.#current,
            sourcesRetained: true,
            keysReleased: true,
        };
    }

    async #fixture(initialize: boolean = true): Promise<CapturedEffectsFixture> {
        const fixture: CapturedEffectsFixture = await CapturedEffectsFixture.create(
            initialize,
            this.input.directory,
        );
        this.#fixtures.push(fixture);
        return fixture;
    }

    async #execute(
        fixture: CapturedEffectsFixture,
        original: ConnectorFilePermit,
    ): Promise<ConnectorFileCompletion> {
        await using client: ConnectorClientFiles = await ConnectorClientFiles.load(
            fixture.history.identity,
        );
        const permit: ConnectorFilePermit = fixture.permit(original);
        return await client.execute(permit, permit.leaseId, permit.expiresAtMs + 10000n);
    }

    async #case(selected: QualificationCase): Promise<void> {
        const fixture: CapturedEffectsFixture = await this.#fixture(
            selected !== QualificationCase.Migration,
        );
        const permit: ConnectorFilePermit = fixture.permit();
        const destination: string = join(fixture.history.files.root, 'destination');
        await writeFile(destination, 'ORIGINAL', { mode: 0o600 });
        if (selected === QualificationCase.Fresh) {
            const completed: ConnectorFileCompletion = await this.#execute(fixture, permit);
            const pending: ConnectorJournalPending<
                ConnectorFileOperation,
                ConnectorFileResponse
            > | null = await fixture.history.pending();
            check(
                completed.response.ok &&
                    pending?.effectContext.kind === ConnectorEffectKind.CapturedFile &&
                    pending.response !== null &&
                    pending.requestHash === permit.requestHash,
            );
            check((await readFile(destination, 'utf8')) === 'NEW');
        } else if (selected === QualificationCase.Migration) {
            await this.#migration(fixture, permit);
        } else if (selected === QualificationCase.Pinned) {
            await this.#pinned(fixture, permit);
        } else {
            const original: CapturedOriginal = await fixture.seed(
                permit,
                selected === QualificationCase.Terminal,
            );
            if (selected === QualificationCase.Root || selected === QualificationCase.Staging) {
                await this.#replacement(fixture, permit, selected);
            } else if (selected === QualificationCase.Terminal) {
                await this.#terminal(fixture, permit, original);
            } else {
                await writeFile(fixture.history.staged(permit), 'ORIGINAL PARTIAL', {
                    mode: 0o600,
                });
                const privateCanary: string = join(
                    fixture.history.files.directory,
                    'private-canary',
                );
                await writeFile(privateCanary, 'PRIVATE CANARY', { mode: 0o600 });
                const foreignStage: string = join(
                    fixture.history.files.directory,
                    'staging',
                    'write-foreign',
                );
                if (selected === QualificationCase.Started) {
                    await writeFile(foreignStage, 'FOREIGN STAGE', { mode: 0o600 });
                }
                if (selected === QualificationCase.Preparation) {
                    const result: QualificationCommandResult = await this.#command(
                        QualificationCommand.Preparation,
                        fixture,
                    );
                    check(
                        result.code === 1 &&
                            result.body['localReady'] === false &&
                            result.body['remoteStateVerified'] === false,
                    );
                } else {
                    const completion: ConnectorFileCompletion = await this.#execute(
                        fixture,
                        permit,
                    );
                    check(
                        !completion.response.ok &&
                            completion.response.error === ConnectorFileFailure.Indeterminate,
                    );
                }
                const pending: ConnectorJournalPending<
                    ConnectorFileOperation,
                    ConnectorFileResponse
                > | null = await fixture.history.pending();
                check(
                    pending?.effectContext.kind === ConnectorEffectKind.CapturedFile &&
                        pending.response !== null &&
                        !pending.response.ok &&
                        pending.response.error === ConnectorFileFailure.Indeterminate,
                );
                check((await readFile(destination, 'utf8')) === 'ORIGINAL');
                await this.#absent(fixture.history.staged(permit));
                check((await readFile(privateCanary, 'utf8')) === 'PRIVATE CANARY');
                if (selected === QualificationCase.Started) {
                    check((await readFile(foreignStage, 'utf8')) === 'FOREIGN STAGE');
                } else {
                    check(
                        (await readdir(join(fixture.history.files.directory, 'staging'))).length ===
                            0,
                    );
                }
            }
        }
    }

    async #absent(path: string): Promise<void> {
        try {
            await lstat(path);
        } catch (caught: unknown) {
            if (caught instanceof Error && 'code' in caught && caught.code === 'ENOENT') {
                return;
            }
            throw caught;
        }
        throw new Error('Owned temporary was not removed');
    }

    async #replacement(
        fixture: CapturedEffectsFixture,
        permit: ConnectorFilePermit,
        selected: QualificationCase.Root | QualificationCase.Staging,
    ): Promise<void> {
        const staged: string = fixture.history.staged(permit);
        await writeFile(staged, 'ORIGINAL PARTIAL', { mode: 0o600 });
        const target: string =
            selected === QualificationCase.Root
                ? fixture.history.files.root
                : join(fixture.history.files.directory, 'staging');
        await rename(target, target + '-original');
        await mkdir(target, { mode: 0o700 });
        if (selected === QualificationCase.Root) {
            await writeFile(join(target, 'destination'), 'FOREIGN ROOT', { mode: 0o600 });
        } else {
            await writeFile(staged, 'FOREIGN STAGE', { mode: 0o600 });
        }
        const cipher: Buffer = await readFile(join(fixture.history.state, 'file-journal'));
        let refused: boolean = false;
        try {
            await this.#execute(fixture, permit);
        } catch {
            refused = true;
        }
        check(
            refused && (await readFile(join(fixture.history.state, 'file-journal'))).equals(cipher),
        );
        check(
            (await readFile(join(fixture.history.files.root, 'destination'), 'utf8')) ===
                (selected === QualificationCase.Root ? 'FOREIGN ROOT' : 'ORIGINAL'),
        );
        check(
            (await readFile(
                selected === QualificationCase.Staging
                    ? join(target + '-original', basename(staged))
                    : staged,
                'utf8',
            )) === 'ORIGINAL PARTIAL',
        );
        if (selected === QualificationCase.Root) {
            check(
                (await readFile(join(target + '-original', 'destination'), 'utf8')) === 'ORIGINAL',
            );
        } else {
            check((await readFile(staged, 'utf8')) === 'FOREIGN STAGE');
        }
    }

    async #pinned(fixture: CapturedEffectsFixture, permit: ConnectorFilePermit): Promise<void> {
        await using filesystem: ConnectorFilesystem = await fixture.filesystem();
        const effect: ConnectorCapturedFileEffect = await filesystem.effectContext('project');
        const root: string = fixture.history.files.root;
        await rename(root, root + '-original');
        await mkdir(root, { mode: 0o700 });
        await writeFile(join(root, 'destination'), 'FOREIGN ROOT', { mode: 0o600 });
        const response: ConnectorFileResponse = await filesystem.dispatchBound(
            ConnectorFileJobsCodec.encode(permit.request),
            fixture.token(permit),
            effect,
        );
        check(response.ok);
        await filesystem.cleanupWrite(permit.request, fixture.token(permit), effect);
        check((await readFile(join(root + '-original', 'destination'), 'utf8')) === 'NEW');
        check((await readFile(join(root, 'destination'), 'utf8')) === 'FOREIGN ROOT');
    }

    async #terminal(
        fixture: CapturedEffectsFixture,
        permit: ConnectorFilePermit,
        original: CapturedOriginal,
    ): Promise<void> {
        for (const path of [
            fixture.history.files.root,
            join(fixture.history.files.directory, 'staging'),
        ]) {
            await rename(path, path + '-original');
            await mkdir(path, { mode: 0o700 });
        }
        await writeFile(join(fixture.history.files.root, 'destination'), 'FOREIGN ROOT', {
            mode: 0o600,
        });
        await writeFile(fixture.history.staged(permit), 'FOREIGN STAGE', { mode: 0o600 });
        const cipher: Buffer = await readFile(join(fixture.history.state, 'file-journal'));
        const completion: ConnectorFileCompletion = await this.#execute(fixture, permit);
        check(
            original.response !== null &&
                completion.responseHash === ConnectorFileProof.responseHash(original.response),
        );
        check((await readFile(join(fixture.history.state, 'file-journal'))).equals(cipher));
        check(
            (await readFile(join(fixture.history.files.root, 'destination'), 'utf8')) ===
                'FOREIGN ROOT',
        );
        check((await readFile(fixture.history.staged(permit), 'utf8')) === 'FOREIGN STAGE');
    }

    async #migration(fixture: CapturedEffectsFixture, permit: ConnectorFilePermit): Promise<void> {
        const codec: ConnectorFileJournalCodec = new ConnectorFileJournalCodec();
        const journalId: string = randomBytes(32).toString('hex');
        {
            await using store: ConnectorJournalStore<
                OriginalJournalFixtureSnapshot<ConnectorFileOperation, ConnectorFileResponse>
            > = await ConnectorJournalStore.open(
                fixture.history.state,
                fixture.history.identity.settings.enrollmentId,
                fixture.history.identity.key,
                codec.purpose,
                new OriginalJournalFixtureCodec(codec),
            );
            await store.write(
                { journalId, acknowledgedSequence: 0n, receipt: null, pending: null },
                true,
            );
        }
        await fixture.history.retainOriginal(permit);
        const cipher: Buffer = await readFile(join(fixture.history.state, 'file-journal'));
        let refused: boolean = false;
        try {
            await using journal: ConnectorOperationJournal<
                ConnectorFileOperation,
                ConnectorFileResponse
            > = await fixture.history.journal();
            check(journal.id.length > 0);
        } catch {
            refused = true;
        }
        check(
            refused && (await readFile(join(fixture.history.state, 'file-journal'))).equals(cipher),
        );
        const prepared: QualificationCommandResult = await this.#command(
            QualificationCommand.PrepareMigration,
            fixture,
        );
        check(prepared.code === 0);
        const plan: ConnectorMigrationPlan = ConnectorMigrationPlanCodec.read(prepared.body);
        const source: ConnectorMigrationSource | undefined = plan.sources[0];
        check(
            plan.sources.length === 1 &&
                source?.lane === ConnectorMigrationLane.Files &&
                source.journalId === journalId &&
                source.sourceSha256 === fixture.history.originalSourceSha256 &&
                source.acknowledgedSequence === 0n &&
                source.receipt === null &&
                source.pending?.requestHash === permit.requestHash &&
                source.pending.jobId === permit.jobId &&
                source.pending.sequence === permit.sequence &&
                source.pending.dispatchId === permit.dispatchId,
        );
        check((await readFile(join(fixture.history.state, 'file-journal'))).equals(cipher));
        const approval: ConnectorMigrationApproval = this.#fixtureApproval(fixture, plan);
        const approvalFile: string = join(
            dirname(fixture.history.identity.settings.privateKeyFile),
            'qualification-admission-approval.json',
        );
        await writeFile(approvalFile, ConnectorMigrationApprovalCodec.encode(approval), {
            mode: 0o600,
            flag: 'wx',
        });
        const result: QualificationCommandResult = await this.#command(
            QualificationCommand.Migration,
            fixture,
            approvalFile,
        );
        check(
            result.code === 0 &&
                result.body['complete'] === true &&
                result.body['upgraded'] === 1 &&
                result.body['historicalPending'] === 1,
        );
        {
            await using journal: ConnectorOperationJournal<
                ConnectorFileOperation,
                ConnectorFileResponse
            > = await fixture.history.journal();
            const pending: ConnectorJournalPending<
                ConnectorFileOperation,
                ConnectorFileResponse
            > | null = journal.pending;
            check(
                journal.id === journalId &&
                    journal.acknowledgedSequence === 0n &&
                    pending?.requestHash === permit.requestHash &&
                    pending.response === null,
            );
            check(
                pending !== null &&
                    ConnectorFileJobsCodec.encode(pending.request) ===
                        ConnectorFileJobsCodec.encode(permit.request),
            );
            check(
                pending?.effectContext.kind === ConnectorEffectKind.HistoricalUnproven &&
                    pending.effectContext.sourceSha256 === fixture.history.originalSourceSha256,
            );
        }
        const converted: Buffer = await readFile(join(fixture.history.state, 'file-journal'));
        const repeated: QualificationCommandResult = await this.#command(
            QualificationCommand.Migration,
            fixture,
            approvalFile,
        );
        check(
            repeated.code === 0 &&
                repeated.body['complete'] === true &&
                repeated.body['upgraded'] === 0,
        );
        check((await readFile(join(fixture.history.state, 'file-journal'))).equals(converted));
    }

    /** TEST ONLY: this fixture key certifies local conversion; its synthetic fence never proves backend fencing or production authority. */
    #fixtureApproval(
        fixture: CapturedEffectsFixture,
        plan: ConnectorMigrationPlan,
    ): ConnectorMigrationApproval {
        const source: ConnectorMigrationSource | undefined = plan.sources[0];
        if (
            plan.sources.length !== 1 ||
            source?.lane !== ConnectorMigrationLane.Files ||
            source.pending === null ||
            source.receipt !== null
        ) {
            throw new Error(
                'Finite file migration fixture requires its exact original pending history',
            );
        }
        const expected: ConnectorMigrationExpected = {
            authorityId: fixture.history.identity.authority.authorityId,
            authorityPublicKey: fixture.history.identity.authority.publicKey,
            environmentId: fixture.history.identity.settings.environmentId,
            enrollmentId: fixture.history.identity.settings.enrollmentId,
            devicePublicKey: fixture.history.identity.publicKey,
        };
        const authorization: ConnectorAuthorization = {
            kind: ConnectorAuthorizationKind.Independent,
        };
        return ConnectorAdmissionMigrationProof.signApproval(
            fixture.history.identity.key,
            expected,
            {
                plan,
                fenceId: 'test-only-no-backend-fence-' + randomBytes(16).toString('hex'),
                authorizations: [
                    {
                        lane: ConnectorMigrationLane.Files,
                        backendSourceSha256: createHash('sha256')
                            .update('TEST-ONLY: no production backend fencing:')
                            .update(plan.planId)
                            .update(source.sourceSha256)
                            .digest('hex'),
                        receipt: null,
                        pending: {
                            authorization,
                            admissionHash: ConnectorAuthorizationProof.file(
                                source.pending.requestHash,
                                authorization,
                            ),
                        },
                    },
                ],
            },
        );
    }

    async #command(
        command: QualificationCommand,
        fixture: CapturedEffectsFixture,
        approvalFile: string | null = null,
    ): Promise<QualificationCommandResult> {
        check(
            !this.#closed &&
                (command === QualificationCommand.Migration) === (approvalFile !== null),
        );
        const child: ChildProcess = spawn(
            '/proc/self/fd/3',
            [
                this.input.application,
                'connector',
                command,
                '--config',
                fixture.history.identity.configurationFile,
                ...(approvalFile === null ? [] : ['--approval', ProtectedFiles.path(approvalFile)]),
            ],
            {
                cwd: this.input.directory,
                env: { LANG: 'C', LC_ALL: 'C', NODE_OPTIONS: '' },
                stdio: ['ignore', 'pipe', 'pipe', this.#node.fd],
            },
        );
        const done: PromiseWithResolvers<number | null> = Promise.withResolvers<number | null>();
        let invalid: boolean = false;
        let size: number = 0;
        let errors: number = 0;
        const chunks: Buffer[] = [];
        const timeout: NodeJS.Timeout = setTimeout((): void => {
            invalid = true;
            child.kill('SIGKILL');
        }, 15000);
        child.once('error', (): void => {
            invalid = true;
        });
        child.stdout?.on('data', (chunk: Buffer): void => {
            size += chunk.byteLength;
            if (size > 65536) {
                invalid = true;
                child.kill('SIGKILL');
            } else {
                chunks.push(chunk);
            }
        });
        child.stderr?.on('data', (chunk: Buffer): void => {
            errors += chunk.byteLength;
            if (errors > 8192) {
                invalid = true;
                child.kill('SIGKILL');
            }
        });
        child.once('close', (code: number | null): void => {
            clearTimeout(timeout);
            done.resolve(code);
        });
        const code: number | null = await done.promise;
        check(!invalid);
        const raw: unknown = JSON.parse(
            new TextDecoder('utf-8', { fatal: true }).decode(Buffer.concat(chunks, size)),
        );
        if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) {
            throw new Error('Invalid private product report');
        }
        return {
            code,
            body: Boundary.record(
                raw,
                command === QualificationCommand.PrepareMigration
                    ? [
                          'authorityId',
                          'environmentId',
                          'enrollmentId',
                          'devicePublicKey',
                          'planId',
                          'targetOperationSchema',
                          'sources',
                          'signature',
                      ]
                    : [
                          'complete',
                          'upgraded',
                          'alreadyCurrent',
                          'historicalPending',
                          'localReady',
                          'remoteStateVerified',
                          'files',
                          'execution',
                      ],
            ),
        };
    }
}

let report: QualificationReport;
try {
    await using qualification: FileEffectQualification = await FileEffectQualification.create(
        await settings(),
    );
    report = await qualification.run();
} catch {
    report = {
        passed: false,
        cases: [],
        failed: QualificationCase.Input,
        sourcesRetained: true,
        keysReleased: true,
    };
}
process.stdout.write(JSON.stringify(report) + '\n');
process.exitCode = report.passed ? 0 : 1;
