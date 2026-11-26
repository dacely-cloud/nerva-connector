// SPDX-FileCopyrightText: 2026 Dacely <business@dacely.com>
// SPDX-License-Identifier: LicenseRef-Proprietary

import { createHash } from 'node:crypto';
import type { Duplex } from 'node:stream';
import { ExecutionMachineBoundary } from 'nerva-connector-protocol/execution/ExecutionMachineBoundary.js';
import { ExecutionInputCodec } from 'nerva-connector-protocol/execution/ExecutionInputCodec.js';
import { ExecutionNativePipeCodec as Codec } from './ExecutionNativePipeCodec.js';
import {
    ExecutionNativePipeCommandKind,
    ExecutionNativePipeEventKind,
    ExecutionNativePipeFailure,
    ExecutionNativePipeLimits as Limits,
    type ExecutionNativePipeCommand,
    type ExecutionNativePipeApplied,
    type ExecutionNativePipeReady,
    type ExecutionNativePipeEvent,
    type ExecutionNativePipeBudget,
    type ExecutionNativePipeCapturedCommand,
} from './ExecutionNativePipeProtocol.js';

/** One immutable input stays owned until the separate native broker confirms its exact accepted range. */
interface NativePipePending {
    readonly command: ExecutionNativePipeCommand;
    readonly identity: string;
    readonly completion: PromiseWithResolvers<ExecutionNativePipeApplied>;
}
/** A native cursor is local evidence; the signed durable operation owner separately admits remote receipts. */
export interface ExecutionNativePipeCursor {
    readonly processedSequence: bigint | null;
    readonly processedInputHash: string | null;
    readonly acceptedOffset: bigint;
    readonly initialAccepted: boolean;
    readonly ended: boolean;
}

/** This native-only handle cannot authorize a command, discover a current job or reconnect a lost native owner. */
export class ExecutionNativePipeHandle {
    readonly #readiness: PromiseWithResolvers<ExecutionNativePipeReady> =
        Promise.withResolvers<ExecutionNativePipeReady>();
    readonly #initial: Buffer;
    readonly #incarnation: string;
    readonly #budget: ExecutionNativePipeBudget;
    readonly #deadlineMs: bigint;
    #channel: Duplex | null = null;
    #fault: ((reason: ExecutionNativePipeFailure) => void) | null = null;
    #buffer: Buffer = Buffer.alloc(0);
    #ready: boolean = false;
    #closed: boolean = false;
    #pending: NativePipePending | null = null;
    #last: NativePipePending | null = null;
    #receipt: ExecutionNativePipeApplied | null = null;
    #next: bigint = 0n;
    #offset: bigint = 0n;
    #initialAccepted: boolean = false;
    #ended: boolean = false;

    /** Bootstrap data is detached before native admission; initial zero remains a later explicit broker record. */
    public constructor(
        incarnation: string,
        initial: string,
        budget: ExecutionNativePipeBudget,
        executionDeadlineMs: bigint,
    ) {
        if (
            typeof executionDeadlineMs !== 'bigint' ||
            executionDeadlineMs <= 0n ||
            executionDeadlineMs > 9223372036854775807n
        ) {
            throw new Error('Captured native Pipe deadline required');
        }
        this.#deadlineMs = executionDeadlineMs;
        this.#incarnation = ExecutionInputCodec.digest(incarnation);
        this.#initial = Buffer.from(ExecutionMachineBoundary.data(initial, 1024));
        const value: Readonly<Record<string, unknown>> = ExecutionMachineBoundary.record(budget, [
            'maximumInputBytes',
            'maximumControls',
        ]);
        const bytes: unknown = value['maximumInputBytes'];
        if (
            typeof bytes !== 'bigint' ||
            bytes < BigInt(this.#initial.byteLength) ||
            bytes > Limits.totalBytes
        ) {
            throw new Error('Explicit native Pipe input budget required');
        }
        this.#budget = Object.freeze({
            maximumInputBytes: bytes,
            maximumControls: ExecutionMachineBoundary.count(
                value['maximumControls'],
                1,
                Number(Limits.controls),
            ),
        });
        void this.#observe();
    }

    /** This immutable captured lifetime is independent of the shorter start/delivery eligibility windows. */
    public get executionDeadlineMs(): bigint {
        return this.#deadlineMs;
    }

    /** No stdout marker or API dispatch receipt resolves this promise. */
    public get ready(): Promise<ExecutionNativePipeReady> {
        return this.#readiness.promise;
    }

    /** The sandbox checks its sealed bootstrap against this exact detached owner before any native admission. */
    public assertBootstrap(
        incarnation: string,
        initial: string,
        maximumInputBytes: bigint,
        maximumControls: number,
        executionDeadlineMs: bigint,
    ): void {
        if (
            this.#closed ||
            incarnation !== this.#incarnation ||
            !Buffer.from(initial).equals(this.#initial) ||
            maximumInputBytes !== this.#budget.maximumInputBytes ||
            maximumControls !== this.#budget.maximumControls ||
            executionDeadlineMs !== this.executionDeadlineMs
        ) {
            throw new Error('Native Pipe bootstrap owner changed');
        }
    }

    /** Only the sandbox may attach its fixed separate inherited native control descriptor. */
    public attach(
        channel: Duplex,
        fault: (reason: ExecutionNativePipeFailure) => void,
        started: () => void,
    ): void {
        if (this.#closed || this.#channel !== null) {
            throw new Error('Native Pipe handle already consumed');
        }
        this.#channel = channel;
        this.#fault = fault;
        channel.on('data', (bytes: unknown): void => {
            try {
                if (
                    !Buffer.isBuffer(bytes) ||
                    this.#buffer.byteLength + bytes.byteLength > Limits.encodedEventBytes * 2
                ) {
                    throw new Error('Native Pipe event exceeds its bound');
                }
                this.#buffer = Buffer.concat([this.#buffer, bytes]);
                for (;;) {
                    const end: number = this.#buffer.indexOf(10);
                    if (end < 0) {
                        if (this.#buffer.byteLength > Limits.encodedEventBytes) {
                            throw new Error('Native Pipe event exceeds its bound');
                        }
                        return;
                    }
                    if (end > Limits.encodedEventBytes) {
                        throw new Error('Native Pipe event exceeds its bound');
                    }
                    const raw: unknown = JSON.parse(
                        new TextDecoder('utf-8', { fatal: true }).decode(
                            this.#buffer.subarray(0, end),
                        ),
                    );
                    this.#buffer = this.#buffer.subarray(end + 1);
                    this.#event(Codec.event(raw), started);
                }
            } catch {
                this.#fail(true);
            }
        });
        channel.once('error', (): void => this.#fail(true));
        channel.once('end', (): void => this.#fail(false));
        channel.once('close', (): void => this.#fail(false));
    }

    /** The caller supplies only an already authorized command; one pending control cannot be replaced by another. */
    public async send(command: ExecutionNativePipeCommand): Promise<ExecutionNativePipeApplied> {
        const captured: ExecutionNativePipeCapturedCommand = Codec.capture(command);
        const encoded: string = captured.encoded;
        const detached: ExecutionNativePipeCommand = captured.command;
        if (
            this.#closed ||
            !this.#ready ||
            detached.incarnation !== this.#incarnation ||
            detached.deliveryExpiresAtMs > this.executionDeadlineMs
        ) {
            throw new Error('Original native Pipe owner unavailable');
        }
        if (this.#pending !== null) {
            if (captured.identity !== this.#pending.identity) {
                throw new Error('Another native Pipe control is in flight');
            }
            return await this.#pending.completion.promise;
        }
        if (this.#last?.identity === captured.identity && this.#receipt !== null) {
            return this.#receipt;
        }
        if (
            this.#ended ||
            detached.inputSequence >= BigInt(this.#budget.maximumControls) ||
            this.#offset +
                (detached.kind === ExecutionNativePipeCommandKind.Data ? detached.byteLength : 0n) >
                this.#budget.maximumInputBytes ||
            detached.inputSequence !== this.#next ||
            detached.offset !== this.#offset ||
            (!this.#initialAccepted &&
                (detached.kind !== ExecutionNativePipeCommandKind.Data ||
                    !Codec.bytes(detached.dataBase64).equals(this.#initial)))
        ) {
            throw new Error('Native Pipe input sequence or original initial bytes changed');
        }
        const channel: Duplex | null = this.#channel;
        if (channel === null) {
            throw new Error('Native Pipe broker is unavailable');
        }
        const pending: NativePipePending = {
            command: detached,
            identity: captured.identity,
            completion: Promise.withResolvers<ExecutionNativePipeApplied>(),
        };
        this.#pending = pending;
        channel.write(encoded, (error: Error | null | undefined): void => {
            if (error !== undefined && error !== null) {
                this.#fail(true);
            }
        });
        return await pending.completion.promise;
    }

    /** The sandbox owns native process cleanup; closing this borrowed descriptor never asserts input delivery. */
    public close(): void {
        this.#fail(false);
    }

    /** Only confirmed complete kernel ranges are exposed after native ownership loss. */
    public cursor(): ExecutionNativePipeCursor {
        return Object.freeze({
            processedSequence: this.#receipt?.inputSequence ?? null,
            processedInputHash: this.#receipt?.inputHash ?? null,
            acceptedOffset: this.#offset,
            initialAccepted: this.#initialAccepted,
            ended: this.#ended,
        });
    }

    #event(event: ExecutionNativePipeEvent, started: () => void): void {
        if (this.#closed || event.incarnation !== this.#incarnation) {
            throw new Error('Native Pipe incarnation changed');
        }
        if (event.kind === ExecutionNativePipeEventKind.Ready) {
            if (
                this.#ready ||
                event.initialInputBytes !== this.#initial.byteLength ||
                event.initialInputHash !== createHash('sha256').update(this.#initial).digest('hex')
            ) {
                throw new Error('Native Pipe Ready commitment changed');
            }
            this.#ready = true;
            started();
            this.#readiness.resolve(event);
            return;
        }
        if (event.kind === ExecutionNativePipeEventKind.TimedOut) {
            if (!this.#ready) {
                throw new Error('Native timeout requires the original executed owner');
            }
            this.#fail(true, ExecutionNativePipeFailure.Timeout);
            return;
        }
        const pending: NativePipePending | null = this.#pending;
        if (event.kind === ExecutionNativePipeEventKind.Expired) {
            if (
                !this.#ready ||
                pending === null ||
                event.inputSequence !== pending.command.inputSequence ||
                event.inputHash !== pending.command.inputHash ||
                event.confirmedOffset !== this.#offset
            ) {
                throw new Error(
                    'Native Pipe expiry changed its pending original or confirmed lower bound',
                );
            }
            this.#fail(true);
            return;
        }
        if (
            !this.#ready ||
            pending === null ||
            event.inputSequence !== pending.command.inputSequence ||
            event.inputHash !== pending.command.inputHash ||
            event.acceptedOffset !==
                this.#offset +
                    (pending.command.kind === ExecutionNativePipeCommandKind.Data
                        ? pending.command.byteLength
                        : 0n) ||
            event.ended !== (pending.command.kind === ExecutionNativePipeCommandKind.End)
        ) {
            throw new Error('Native Pipe acceptance does not match its pending original');
        }
        this.#offset = event.acceptedOffset;
        this.#next++;
        if (event.inputSequence === 0n) {
            this.#initialAccepted = true;
        }
        this.#ended = event.ended;
        this.#pending = null;
        this.#last = pending;
        this.#receipt = event;
        pending.completion.resolve(event);
    }

    #fail(
        stop: boolean,
        reason: ExecutionNativePipeFailure = ExecutionNativePipeFailure.Owner,
    ): void {
        if (!this.#closed) {
            this.#closed = true;
            const error: Error = new Error(
                'Native Pipe ownership ended; input delivery is unconfirmed',
            );
            this.#readiness.reject(error);
            this.#pending?.completion.reject(error);
            this.#pending = null;
            this.#channel?.destroy();
            if (stop) {
                this.#fault?.(reason);
            }
        }
    }

    async #observe(): Promise<void> {
        await Promise.allSettled([this.#readiness.promise]);
    }
}
