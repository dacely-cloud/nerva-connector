// SPDX-FileCopyrightText: 2026 Nerva contributors
// SPDX-License-Identifier: LicenseRef-Proprietary

import { HostByteRing } from './HostByteRing.js';
import { HostReadRevision } from './HostReadRevision.js';
import type { HostProcessReport } from './HostProcessReport.js';
import type { HostProcessOutput } from './HostWorkspaceTypes.js';

/** Final stream totals prove completion only after those exact bytes reach the local rings. */
export class HostProcessOutputState {
    readonly #stdout: HostByteRing = new HostByteRing();
    readonly #stderr: HostByteRing = new HostByteRing();
    #stdoutFinal: bigint | null = null;
    #stderrFinal: bigint | null = null;
    #report: HostProcessReport | null = null;

    /** A process supplies its actual retained owner's hint cell; isolated output-state users own a private cell. */
    public constructor(public readonly changes: HostReadRevision = new HostReadRevision()) {}

    /** Byte accounting follows actual received stdout data, independently from the control channel. */
    public appendStdout(bytes: Buffer): void {
        this.#stdout.append(bytes);
        if (bytes.length !== 0) {
            this.changes.advance();
        }
    }

    /** Byte accounting follows actual received stderr data, independently from the control channel. */
    public appendStderr(bytes: Buffer): void {
        this.#stderr.append(bytes);
        if (bytes.length !== 0) {
            this.changes.advance();
        }
    }

    /** EOF counts cannot be withdrawn or changed by a later report. */
    public accept(report: HostProcessReport): void {
        if (this.#report?.treeRunning === false && report.treeRunning !== false) {
            throw new Error('Host process tree quiescence evidence changed');
        }
        if (
            this.#report !== null &&
            (report.exitCode !== this.#report.exitCode ||
                report.signal !== this.#report.signal ||
                report.launchFailed !== this.#report.launchFailed)
        ) {
            throw new Error('Host process exit observation changed');
        }
        if (
            (this.#stdoutFinal !== null && report.stdoutFinalBytes !== this.#stdoutFinal) ||
            (this.#stderrFinal !== null && report.stderrFinalBytes !== this.#stderrFinal)
        ) {
            throw new Error('Host process EOF evidence changed');
        }
        const changed: boolean =
            this.#report === null ||
            this.#report.treeRunning !== report.treeRunning ||
            this.#stdoutFinal !== report.stdoutFinalBytes ||
            this.#stderrFinal !== report.stderrFinalBytes;
        this.#report = report;
        this.#stdoutFinal = report.stdoutFinalBytes;
        this.#stderrFinal = report.stderrFinalBytes;
        if (changed) {
            this.changes.advance();
        }
    }

    /** Completion remains false while either output pipe has not reported EOF or bytes remain in transit. */
    public get complete(): boolean {
        return (
            this.#stdoutFinal !== null &&
            this.#stderrFinal !== null &&
            this.#stdout.endOffset === this.#stdoutFinal &&
            this.#stderr.endOffset === this.#stderrFinal
        );
    }

    /** A final exact stdout total is known only after its child pipe reaches EOF. */
    public get stdoutFinalBytes(): bigint | null {
        return this.#stdoutFinal;
    }

    /** A final exact stderr total is known only after its child pipe reaches EOF. */
    public get stderrFinalBytes(): bigint | null {
        return this.#stderrFinal;
    }

    /** Bounded stdout windows retain explicit truncation and exact continuation offsets. */
    public stdout(offset: bigint, maximum: number): HostProcessOutput {
        return this.#stdout.read(offset, maximum);
    }

    /** Bounded stderr windows retain explicit truncation and exact continuation offsets. */
    public stderr(offset: bigint, maximum: number): HostProcessOutput {
        return this.#stderr.read(offset, maximum);
    }
}
