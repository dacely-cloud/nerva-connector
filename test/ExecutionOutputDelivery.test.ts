// SPDX-FileCopyrightText: 2026 Nerva contributors
// SPDX-License-Identifier: LicenseRef-Proprietary

import { ExecutionAppArmorInstaller } from '../src/execution/ExecutionAppArmorInstaller.js';
import { ExecutionConfiguration } from '../src/execution/ExecutionConfiguration.js';
import { ExecutionPolicy } from '../src/execution/ExecutionPolicy.js';
import { readFile, readdir } from 'node:fs/promises';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { expect, it } from 'vitest';
import { ExecutionFixture } from './support/ExecutionFixture.js';
import { ExecutionIdentity } from './support/ExecutionIdentity.js';
import { setup } from './support/ExecutionSetup.js';
import { ExecutionJournalInstallation } from '../src/execution/ExecutionJournalInstallation.js';
import { ExecutionClient } from '../src/execution/ExecutionClient.js';
import { ExecutionDelivery } from '../src/execution/ExecutionDelivery.js';
import { type ExecutionDeliveryLink } from '../src/execution/ExecutionDeliveryLink.js';
import type {
    ExecutionOutputUpdate,
    ExecutionOutputAck,
} from 'nerva-connector-protocol/execution/ExecutionOutput.js';
import { ExecutionProof } from 'nerva-connector-protocol/execution/ExecutionProof.js';
import {
    ConnectorFrameKind,
    type ConnectorClientFrame,
} from '../src/protocol/ConnectorTransport.js';
import type { ExecutionClientSettings } from '../src/execution/ExecutionClientSettings.js';
import type { ConnectorDeviceLease } from 'nerva-connector-protocol/protocol/ConnectorDevice.js';
import type {
    ExecutionCompletion,
    ExecutionPermit,
} from 'nerva-connector-protocol/execution/ExecutionJobs.js';
import { ExecutionFailure } from 'nerva-connector-protocol/execution/ExecutionTypes.js';
import {
    IdentityLengths,
    SignaturePurpose,
} from 'nerva-connector-protocol/identity/IdentityFormat.js';

const helper: string | undefined = process.env['NERVA_CONNECTOR_EXEC_HELPER'];

it.skipIf(helper === undefined)(
    'a replacement lease resends the original retained prefix and refuses old output credit without repeating effects',
    async (): Promise<void> => {
        if (helper === undefined) {
            throw new Error('Explicit native helper required');
        }
        await using fixture: ExecutionFixture = await ExecutionFixture.create(helper);
        const settings: ExecutionClientSettings = await setup(fixture);
        using authority: ExecutionIdentity = new ExecutionIdentity(fixture.directory, settings);
        await using policy: ExecutionPolicy = await ExecutionConfiguration.loadPolicy(
            authority.identity,
            settings,
        );
        await ExecutionAppArmorInstaller.assertInstalled(policy.definition);
        await ExecutionJournalInstallation.initialize(authority.identity, settings);
        const client: ExecutionClient = await ExecutionClient.load(
            authority.identity,
            settings,
            policy,
        );
        await using delivery: ExecutionDelivery = new ExecutionDelivery(client);
        const lease: ConnectorDeviceLease = authority.lease();
        const permit: ExecutionPermit = authority.permit(
            client.publication(authority.session(lease)).profile,
            lease,
        );
        const firstOutput: PromiseWithResolvers<ExecutionOutputUpdate> =
            Promise.withResolvers<ExecutionOutputUpdate>();
        const secondOutput: PromiseWithResolvers<ExecutionOutputUpdate> =
            Promise.withResolvers<ExecutionOutputUpdate>();
        const result: PromiseWithResolvers<ExecutionCompletion> =
            Promise.withResolvers<ExecutionCompletion>();
        const old: ExecutionDeliveryLink = {
            session: authority.session(lease),
            leaseId: lease.leaseId,
            send: (frame: ConnectorClientFrame): void => {
                if (frame.kind === ConnectorFrameKind.ExecutionOutput) {
                    firstOutput.resolve(frame.update);
                }
                if (frame.kind === ConnectorFrameKind.ExecutionResult) {
                    throw new Error('Unacknowledged result escaped');
                }
            },
            close: (): void => {
                delivery.detach(old);
            },
        };
        delivery.activate(old);
        delivery.receive({ kind: ConnectorFrameKind.ExecutionPermit, permit }, old);
        const original: ExecutionOutputUpdate = await firstOutput.promise;
        delivery.detach(old);
        const replacement: ConnectorDeviceLease = authority.lease();
        const current: ExecutionDeliveryLink = {
            session: authority.session(replacement),
            leaseId: replacement.leaseId,
            send: (frame: ConnectorClientFrame): void => {
                if (frame.kind === ConnectorFrameKind.ExecutionOutput) {
                    secondOutput.resolve(frame.update);
                }
                if (frame.kind === ConnectorFrameKind.ExecutionResult) {
                    result.resolve(frame.completion);
                }
            },
            close: (): void => {
                delivery.detach(current);
            },
        };
        delivery.activate(current);
        const now: bigint = BigInt(Date.now());
        const refreshed: ExecutionPermit = authority.sign({
            ...permit,
            leaseId: replacement.leaseId,
            issuedAtMs: now,
            expiresAtMs: now + 1000n,
            executionDeadlineMs: now + 5000n,
        });
        delivery.receive({ kind: ConnectorFrameKind.ExecutionPermit, permit: refreshed }, current);
        const update: ExecutionOutputUpdate = await secondOutput.promise;
        expect(update.output).toEqual(original.output);
        expect(update.leaseId).not.toBe(original.leaseId);
        const acknowledge: (value: ExecutionOutputUpdate) => ExecutionOutputAck = (
            value: ExecutionOutputUpdate,
        ): ExecutionOutputAck => {
            const unsigned: Omit<ExecutionOutputAck, 'signature'> = {
                authorityId: authority.identity.authority.authorityId,
                lane: value.lane,
                environmentId: value.environmentId,
                enrollmentId: value.enrollmentId,
                leaseId: value.leaseId,
                jobId: value.jobId,
                sequence: value.sequence,
                dispatchId: value.dispatchId,
                requestHash: value.requestHash,
                admissionHash: value.admissionHash,
                outputHash: value.outputHash,
            };
            return {
                ...unsigned,
                signature: authority.authority.sign(
                    SignaturePurpose.OperationExecutionOutputAck,
                    ExecutionProof.outputAck(unsigned),
                ),
            };
        };
        expect((): void => {
            delivery.receive(
                {
                    kind: ConnectorFrameKind.ExecutionOutputAck,
                    acknowledgment: acknowledge(original),
                },
                current,
            );
        }).toThrow();
        delivery.receive(
            { kind: ConnectorFrameKind.ExecutionOutputAck, acknowledgment: acknowledge(update) },
            current,
        );
        expect((await result.promise).response).toMatchObject({ exitCode: 0, ...update.output });
        expect(await readFile(join(fixture.workspace, 'effects'), 'utf8')).toBe('x');
    },
);

it.skipIf(helper === undefined)(
    'one durable signed prefix awaits both backend signatures while independent cancellation still joins native work',
    async (): Promise<void> => {
        if (helper === undefined) {
            throw new Error('Explicit native helper required');
        }
        await using fixture: ExecutionFixture = await ExecutionFixture.create(helper);
        const settings: ExecutionClientSettings = await setup(fixture);
        using authority: ExecutionIdentity = new ExecutionIdentity(fixture.directory, settings);
        await using policy: ExecutionPolicy = await ExecutionConfiguration.loadPolicy(
            authority.identity,
            settings,
        );
        await ExecutionAppArmorInstaller.assertInstalled(policy.definition);
        await ExecutionJournalInstallation.initialize(authority.identity, settings);
        const client: ExecutionClient = await ExecutionClient.load(
            authority.identity,
            settings,
            policy,
        );
        await using delivery: ExecutionDelivery = new ExecutionDelivery(client);
        const lease: ConnectorDeviceLease = authority.lease();
        const permit: ExecutionPermit = authority.permit(
            client.publication(authority.session(lease)).profile,
            lease,
            'output-hold',
        );
        const frames: ConnectorClientFrame[] = [];
        const output: PromiseWithResolvers<ExecutionOutputUpdate> =
            Promise.withResolvers<ExecutionOutputUpdate>();
        const result: PromiseWithResolvers<ExecutionCompletion> =
            Promise.withResolvers<ExecutionCompletion>();
        let closed: boolean = false;
        const link: ExecutionDeliveryLink = {
            session: authority.session(lease),
            leaseId: lease.leaseId,
            send: (frame: ConnectorClientFrame): void => {
                frames.push(frame);
                if (frame.kind === ConnectorFrameKind.ExecutionOutput) {
                    output.resolve(frame.update);
                }
                if (frame.kind === ConnectorFrameKind.ExecutionResult) {
                    result.resolve(frame.completion);
                }
            },
            close: (): void => {
                closed = true;
            },
        };
        delivery.activate(link);
        delivery.receive({ kind: ConnectorFrameKind.ExecutionPermit, permit }, link);
        const update: ExecutionOutputUpdate = await output.promise;
        expect(update.jobId).toBe(permit.jobId);
        expect(update.outputHash).toBe(ExecutionProof.outputHash(update.output));
        expect(Buffer.from(update.output.stdoutBase64, 'base64')).toHaveLength(4096);
        expect(await readFile(join(fixture.workspace, 'effects'), 'utf8')).toBe('x');
        delivery.receive(
            {
                kind: ConnectorFrameKind.ExecutionCancellation,
                cancellation: authority.cancel(permit, lease),
            },
            link,
        );
        const deadline: number = performance.now() + 3000;
        while (
            (await readdir(fixture.delegation)).some((name: string): boolean =>
                name.startsWith('exec-'),
            )
        ) {
            if (performance.now() >= deadline) {
                throw new Error('Output flow control prevented native cancellation');
            }
            await delay(10);
        }
        expect(
            frames.filter(
                (frame: ConnectorClientFrame): boolean =>
                    frame.kind === ConnectorFrameKind.ExecutionOutput,
            ),
        ).toHaveLength(1);
        expect(
            frames.some(
                (frame: ConnectorClientFrame): boolean =>
                    frame.kind === ConnectorFrameKind.ExecutionResult,
            ),
        ).toBe(false);
        const unsigned: Omit<ExecutionOutputAck, 'signature'> = {
            authorityId: authority.identity.authority.authorityId,
            lane: update.lane,
            environmentId: update.environmentId,
            enrollmentId: update.enrollmentId,
            leaseId: update.leaseId,
            jobId: update.jobId,
            sequence: update.sequence,
            dispatchId: update.dispatchId,
            requestHash: update.requestHash,
            admissionHash: update.admissionHash,
            outputHash: update.outputHash,
        };
        const ack: ExecutionOutputAck = {
            ...unsigned,
            signature: authority.authority.sign(
                SignaturePurpose.OperationExecutionOutputAck,
                ExecutionProof.outputAck(unsigned),
            ),
        };
        for (const offset of [0, IdentityLengths.mlDsaSignature]) {
            const signature: Buffer = Buffer.from(ack.signature, 'base64url');
            signature[offset] = (signature[offset] ?? 0) ^ 1;
            expect((): void => {
                delivery.receive(
                    {
                        kind: ConnectorFrameKind.ExecutionOutputAck,
                        acknowledgment: { ...ack, signature: signature.toString('base64url') },
                    },
                    link,
                );
            }).toThrow();
        }
        expect(
            frames.some(
                (frame: ConnectorClientFrame): boolean =>
                    frame.kind === ConnectorFrameKind.ExecutionResult,
            ),
        ).toBe(false);
        delivery.receive(
            { kind: ConnectorFrameKind.ExecutionOutputAck, acknowledgment: ack },
            link,
        );
        const completed: ExecutionCompletion = await result.promise;
        expect(completed.response).toMatchObject({
            ...update.output,
            failure: ExecutionFailure.Cancelled,
            exitCode: null,
        });
        expect(
            frames.filter(
                (frame: ConnectorClientFrame): boolean =>
                    frame.kind === ConnectorFrameKind.ExecutionResult,
            ),
        ).toHaveLength(1);
        expect(closed).toBe(false);
    },
);
