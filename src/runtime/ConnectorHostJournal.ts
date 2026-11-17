// SPDX-FileCopyrightText: 2026 Nerva contributors
// SPDX-License-Identifier: LicenseRef-Proprietary

import { KeyDerivationPurpose } from 'nerva-connector-protocol/identity/IdentityFormat.js';
import { ConnectorHostCodec } from '../protocol/ConnectorHostCodec.js';
import {
    ConnectorHostOutcome,
    ConnectorHostErrorCode,
    type ConnectorHostPermit,
    type ConnectorHostResponse,
    type ConnectorHostAcknowledgment,
} from '../protocol/ConnectorHost.js';
import type { ConnectorClientIdentity } from './ConnectorClientConfiguration.js';
import { ConnectorJournalCipher } from './ConnectorJournalCipher.js';
import { ConnectorPrivateDirectory } from './ConnectorPrivateDirectory.js';
import type { ConnectorHostLocalGrant } from './ConnectorHostGrantTypes.js';
import {
    ConnectorHostJournalState,
    type ConnectorHostSnapshot,
    type ConnectorHostOriginal,
    type ConnectorHostPending,
    type ConnectorHostReceipt,
} from './ConnectorHostJournalState.js';
import { ConnectorHostProof } from './ConnectorHostProof.js';

/** One encrypted host journal owns at-most-once local admission through socket and process replacement. */
export class ConnectorHostJournal implements AsyncDisposable {
    static readonly #plainBytes: number = 524288;
    static readonly #recordBytes: number = 786432;
    #busy: boolean = false;
    #failed: boolean = false;
    readonly #storage: ConnectorPrivateDirectory;
    readonly #encryption: ConnectorJournalCipher<ConnectorHostSnapshot>;
    #snapshot: ConnectorHostSnapshot;
    private constructor(
        owner: ConnectorPrivateDirectory,
        cipher: ConnectorJournalCipher<ConnectorHostSnapshot>,
        snapshot: ConnectorHostSnapshot,
    ) {
        this.#storage = owner;
        this.#encryption = cipher;
        this.#snapshot = ConnectorHostJournal.#freeze(snapshot);
    }
    /** Observers receive immutable retained history and cannot replace the owner's counters or pending original. */
    public get snapshot(): ConnectorHostSnapshot {
        return this.#snapshot;
    }

    /** Explicit local consent creates history once; missing previously-ready history is never reset. */
    public static async initialize(
        owner: ConnectorPrivateDirectory,
        identity: ConnectorClientIdentity,
        grant: ConnectorHostLocalGrant,
    ): Promise<void> {
        using cipher: ConnectorJournalCipher<ConnectorHostSnapshot> = this.#cipher(
            owner,
            identity,
            grant,
        );
        const exists: boolean = await owner.exists('host-journal');
        const ready: boolean = await owner.exists('host-ready');
        if (ready && (await owner.read('host-ready', 4096)).toString() !== grant.journalId) {
            throw new Error('Host journal readiness identity changed');
        }
        if (!exists && (ready || grant.journalInitialized)) {
            throw new Error('Retained host journal is missing; keep its original history');
        }
        await owner.cleanPartial('host-journal', this.#recordBytes);
        if (exists) {
            const snapshot: ConnectorHostSnapshot = cipher.decode(
                await owner.read('host-journal', this.#recordBytes),
            ).state;
            if (snapshot.journalId !== grant.journalId) {
                throw new Error('Host journal identity changed');
            }
        } else {
            await owner.write(
                'host-journal',
                cipher.encode({
                    journalId: grant.journalId,
                    sequence: 0n,
                    acknowledgedSequence: 0n,
                    pending: null,
                    receipt: null,
                }),
                this.#recordBytes,
                true,
            );
        }
        if (!ready) {
            await owner.cleanPartial('host-ready', 4096);
            await owner.write('host-ready', Buffer.from(grant.journalId), 4096, true);
        }
    }

    /** A restarted Started operation becomes indeterminate; it can never be launched a second time. */
    public static async load(
        owner: ConnectorPrivateDirectory,
        identity: ConnectorClientIdentity,
        grant: ConnectorHostLocalGrant,
    ): Promise<ConnectorHostJournal> {
        if (
            !(await owner.exists('host-ready')) ||
            (await owner.read('host-ready', 4096)).toString() !== grant.journalId
        ) {
            throw new Error('Host setup is incomplete; repeat the explicit local approval');
        }
        const cipher: ConnectorJournalCipher<ConnectorHostSnapshot> = this.#cipher(
            owner,
            identity,
            grant,
        );
        try {
            await owner.cleanPartial('host-journal', this.#recordBytes);
            const snapshot: ConnectorHostSnapshot = cipher.decode(
                await owner.read('host-journal', this.#recordBytes),
            ).state;
            if (snapshot.journalId !== grant.journalId) {
                throw new Error('Host journal identity changed');
            }
            const journal: ConnectorHostJournal = new ConnectorHostJournal(owner, cipher, snapshot);
            if (snapshot.pending !== null && snapshot.pending.response === null) {
                await journal.complete(snapshot.pending, {
                    outcome: ConnectorHostOutcome.Indeterminate,
                    resultJson: null,
                    errorCode: ConnectorHostErrorCode.Interrupted,
                });
            }
            return journal;
        } catch (caught: unknown) {
            cipher[Symbol.dispose]();
            throw caught;
        }
    }

    /** A write failure retires the owner rather than admitting further effects without history. */
    public get failed(): boolean {
        return this.#failed;
    }
    /** A matching retained original is observed; only a new committed Started marker returns true. */
    public async begin(permit: ConnectorHostPermit): Promise<boolean> {
        const pending: ConnectorHostPending | null = this.snapshot.pending;
        if (pending !== null) {
            this.#same(pending, permit);
            return false;
        }
        if (
            permit.sequence !== this.snapshot.sequence + 1n ||
            this.snapshot.sequence !== this.snapshot.acknowledgedSequence
        ) {
            throw new Error('Host original sequence was already used or is not next');
        }
        const original: ConnectorHostPending = {
            ...this.#original(permit),
            request: permit.request,
            response: null,
        };
        await this.#write({ ...this.snapshot, sequence: permit.sequence, pending: original });
        return true;
    }
    /**
     * Records the next original's answer without ever marking it started, in one write.
     *
     * @remarks
     * Used for an original refused before any effect, so a restart cannot turn it into an interrupted start and
     * every later delivery returns the same answer.
     *
     * @param permit - The next original, by sequence
     * @param response - Its answer
     * @throws Error if the original is not the next sequence or another original is pending
     */
    public async decline(
        permit: ConnectorHostPermit,
        response: ConnectorHostResponse,
    ): Promise<void> {
        if (
            this.snapshot.pending !== null ||
            permit.sequence !== this.snapshot.sequence + 1n ||
            this.snapshot.sequence !== this.snapshot.acknowledgedSequence
        ) {
            throw new Error('Host original sequence was already used or is not next');
        }
        const checked: ConnectorHostResponse = ConnectorHostCodec.response(
            JSON.parse(ConnectorHostCodec.encode(response)),
        );
        await this.#write({
            ...this.snapshot,
            sequence: permit.sequence,
            pending: { ...this.#original(permit), request: permit.request, response: checked },
        });
    }
    /** Complete the same original before sending any result bytes to the tunnel. */
    public async complete(
        original: ConnectorHostOriginal,
        response: ConnectorHostResponse,
    ): Promise<void> {
        const pending: ConnectorHostPending | null = this.snapshot.pending;
        if (pending === null) {
            throw new Error('Host original is unavailable');
        }
        this.#same(pending, original);
        const checked: ConnectorHostResponse = ConnectorHostCodec.response(
            JSON.parse(ConnectorHostCodec.encode(response)),
        );
        if (
            pending.response !== null &&
            ConnectorHostCodec.encode(pending.response) !== ConnectorHostCodec.encode(checked)
        ) {
            throw new Error('Host result changed after completion');
        }
        await this.#write({ ...this.snapshot, pending: { ...pending, response: checked } });
    }
    /** Cloud result commitment is persisted locally before releasing that sequence for the next job. */
    public async acknowledge(value: ConnectorHostAcknowledgment): Promise<void> {
        const pending: ConnectorHostPending | null = this.snapshot.pending;
        if (pending === null) {
            if (this.snapshot.receipt === null) {
                throw new Error('Host acknowledgment has no original');
            }
            this.#same(this.snapshot.receipt, value);
            if (this.snapshot.receipt.responseHash !== value.responseHash) {
                throw new Error('Host acknowledgment changed result');
            }
            return;
        }
        this.#same(pending, value);
        if (
            pending.response === null ||
            ConnectorHostProof.responseHash(pending.response) !== value.responseHash
        ) {
            throw new Error('Host acknowledgment precedes the original result');
        }
        const receipt: ConnectorHostReceipt = {
            ...this.#original(pending),
            responseHash: value.responseHash,
        };
        await this.#write({
            ...this.snapshot,
            acknowledgedSequence: pending.sequence,
            pending: null,
            receipt,
        });
    }
    /** Caller joins admitted effects before disposing the cipher and its exclusive directory owner. */
    public async [Symbol.asyncDispose](): Promise<void> {
        this.#encryption[Symbol.dispose]();
        await this.#storage[Symbol.asyncDispose]();
    }
    static #cipher(
        owner: ConnectorPrivateDirectory,
        identity: ConnectorClientIdentity,
        grant: ConnectorHostLocalGrant,
    ): ConnectorJournalCipher<ConnectorHostSnapshot> {
        return ConnectorJournalCipher.scoped(
            identity.key,
            {
                purpose: KeyDerivationPurpose.RetainedHost,
                salt: Buffer.from(ConnectorHostCodec.encode([grant.enrollmentId, grant.journalId])),
                aad: Buffer.from(
                    ConnectorHostCodec.encode([
                        'nerva-connector:host-journal',
                        owner.directory,
                        grant.authorityId,
                        grant.enrollmentId,
                        grant.environmentId,
                        grant.journalId,
                    ]),
                ),
                limits: { plainBytes: this.#plainBytes, recordBytes: this.#recordBytes },
            },
            new ConnectorHostJournalState(),
        );
    }
    #original(value: ConnectorHostOriginal): ConnectorHostOriginal {
        return {
            jobId: value.jobId,
            sequence: value.sequence,
            dispatchId: value.dispatchId,
            requestHash: value.requestHash,
        };
    }
    #same(expected: ConnectorHostOriginal, actual: ConnectorHostOriginal): void {
        if (
            ConnectorHostCodec.encode(this.#original(expected)) !==
            ConnectorHostCodec.encode(this.#original(actual))
        ) {
            throw new Error('Host original identity changed');
        }
    }
    async #write(snapshot: ConnectorHostSnapshot): Promise<void> {
        if (this.#busy || this.#failed) {
            throw new Error('Host journal is unavailable');
        }
        this.#busy = true;
        try {
            new ConnectorHostJournalState().read(
                JSON.parse(ConnectorHostCodec.encode(snapshot)),
                '',
            );
            await this.#storage.write(
                'host-journal',
                this.#encryption.encode(snapshot),
                ConnectorHostJournal.#recordBytes,
                false,
            );
            this.#snapshot = ConnectorHostJournal.#freeze(snapshot);
        } catch (caught: unknown) {
            this.#failed = true;
            throw caught;
        } finally {
            this.#busy = false;
        }
    }
    static #freeze(snapshot: ConnectorHostSnapshot): ConnectorHostSnapshot {
        if (snapshot.pending !== null) {
            Object.freeze(snapshot.pending.request);
            Object.freeze(snapshot.pending.response);
            Object.freeze(snapshot.pending);
        }
        Object.freeze(snapshot.receipt);
        return Object.freeze(snapshot);
    }
}
