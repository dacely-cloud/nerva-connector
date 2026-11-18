// SPDX-FileCopyrightText: 2026 Nerva contributors
// SPDX-License-Identifier: LicenseRef-Proprietary

import { randomBytes } from 'node:crypto';
import { readFile, writeFile, readdir, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { expect, it } from 'vitest';
import { SignaturePurpose } from 'nerva-connector-protocol/identity/IdentityFormat.js';
import {
    ConnectorHostTool,
    ConnectorHostOutcome,
    ConnectorHostErrorCode,
    type ConnectorHostPermit,
    type ConnectorHostCompletion,
} from 'nerva-connector-protocol/protocol/ConnectorHost.js';
import { ConnectorHostCodec } from 'nerva-connector-protocol/protocol/ConnectorHostCodec.js';
import { ConnectorClientHost } from '../src/runtime/ConnectorClientHost.js';
import { ConnectorHostGrant } from '../src/runtime/ConnectorHostGrant.js';
import { type ConnectorHostLocalGrant } from '../src/runtime/ConnectorHostGrantTypes.js';
import { ConnectorHostJournal } from '../src/runtime/ConnectorHostJournal.js';
import { ConnectorHostProof } from '../src/runtime/ConnectorHostProof.js';
import {
    ConnectorPrivateDirectory,
    ConnectorDirectoryPurpose,
} from '../src/runtime/ConnectorPrivateDirectory.js';
import { ConnectorHostFixture } from './support/ConnectorHostFixture.js';

it.skipIf(process.platform !== 'linux')(
    'pairing alone opens no host workspace and creates no implicit local consent',
    async (): Promise<void> => {
        await using fixture: ConnectorHostFixture = await ConnectorHostFixture.create();
        expect(await ConnectorClientHost.load(fixture.identity)).toBeNull();
        expect(await readdir(fixture.directory)).toEqual(['tasks']);
    },
);

it.skipIf(process.platform !== 'linux')(
    'paired reads preserve a maximum all-NUL chunk without overflowing signed result envelopes',
    async (): Promise<void> => {
        await using fixture: ConnectorHostFixture = await ConnectorHostFixture.create();
        const grant: ConnectorHostLocalGrant = await fixture.grant();
        await writeFile(join(fixture.tasks, 'zeros.bin'), Buffer.alloc(32768));
        const host: ConnectorClientHost = await fixture.open();
        const permit: ConnectorHostPermit = fixture.permit(
            grant,
            1n,
            ConnectorHostTool.FileRead,
            '{"path":"zeros.bin"}',
        );
        const completion: ConnectorHostCompletion = await host.execute(
            permit,
            permit.leaseId,
            permit.expiresAtMs,
        );
        expect(completion.response.outcome).toBe(ConnectorHostOutcome.Succeeded);
        expect(completion.response.resultJson?.length).toBeLessThan(131072);
        const raw: unknown = JSON.parse(completion.response.resultJson ?? 'null');
        expect(raw).toMatchObject({
            encoding: 'base64',
            offset: '0',
            nextOffset: '32768',
            size: '32768',
            eof: true,
            data: Buffer.alloc(32768).toString('base64'),
        });
    },
);

it.skipIf(process.platform !== 'linux')(
    'the same signed host append is executed once across lease replacement and acknowledged compaction',
    async (): Promise<void> => {
        await using fixture: ConnectorHostFixture = await ConnectorHostFixture.create();
        const grant: ConnectorHostLocalGrant = await fixture.grant();
        const host: ConnectorClientHost = await fixture.open();
        const permit: ConnectorHostPermit = fixture.permit(
            grant,
            1n,
            ConnectorHostTool.FileWrite,
            JSON.stringify({
                path: 'output.txt',
                mode: 'append',
                encoding: 'utf8',
                data: 'one effect\n',
            }),
        );
        const completion: ConnectorHostCompletion = await host.execute(
            permit,
            permit.leaseId,
            permit.expiresAtMs,
        );
        expect(completion.response.outcome).toBe(ConnectorHostOutcome.Succeeded);
        expect(
            ConnectorHostProof.verify(
                fixture.identity.publicKey,
                SignaturePurpose.HostResult,
                ConnectorHostProof.completion(completion),
                completion.signature,
            ),
        ).toBe(true);
        expect((await host.execute(permit, permit.leaseId, permit.expiresAtMs)).response).toEqual(
            completion.response,
        );
        const renewed: ConnectorHostPermit = fixture.sign({
            ...permit,
            leaseId: randomBytes(32).toString('base64url'),
        });
        const renewedCompletion: ConnectorHostCompletion = await host.execute(
            renewed,
            renewed.leaseId,
            renewed.expiresAtMs,
        );
        expect(renewedCompletion.response).toEqual(completion.response);
        expect(await readFile(join(fixture.tasks, 'output.txt'), 'utf8')).toBe('one effect\n');
        await host.acknowledge(fixture.acknowledgment(renewedCompletion), renewed.leaseId);
        await host.acknowledge(fixture.acknowledgment(renewedCompletion), renewed.leaseId);
        await expect(host.execute(renewed, renewed.leaseId, renewed.expiresAtMs)).rejects.toThrow(
            'sequence',
        );
        expect(host.journal.snapshot.sequence).toBe(1n);
        expect(host.journal.snapshot.acknowledgedSequence).toBe(1n);
        const encrypted: Buffer = await readFile(
            join(ConnectorHostGrant.directory(fixture.identity), 'host-journal'),
        );
        expect(encrypted.includes(Buffer.from('one effect'))).toBe(false);
    },
);

it.skipIf(process.platform !== 'linux')(
    'forged, expired and differently bound host permits never admit a local effect',
    async (): Promise<void> => {
        await using fixture: ConnectorHostFixture = await ConnectorHostFixture.create();
        const grant: ConnectorHostLocalGrant = await fixture.grant();
        const host: ConnectorClientHost = await fixture.open();
        const permit: ConnectorHostPermit = fixture.permit(
            grant,
            1n,
            ConnectorHostTool.DirectoryCreate,
            '{"path":"changed","recursive":false}',
        );
        for (const changed of [
            { ...permit, signature: 'A'.repeat(3312) },
            { ...permit, leaseId: randomBytes(32).toString('base64url') },
            { ...permit, journalId: 'f'.repeat(64) },
            fixture.sign({
                ...permit,
                issuedAtMs: BigInt(Date.now()) - 20000n,
                expiresAtMs: BigInt(Date.now()) - 10000n,
            }),
        ]) {
            await expect(
                host.execute(changed, permit.leaseId, permit.expiresAtMs),
            ).rejects.toThrow();
        }
        expect(await readdir(fixture.tasks)).toEqual([]);
        expect(host.journal.snapshot.sequence).toBe(0n);
    },
);

it.skipIf(process.platform !== 'linux')(
    'a restarted Started host original is retained as indeterminate without invoking it again',
    async (): Promise<void> => {
        await using fixture: ConnectorHostFixture = await ConnectorHostFixture.create();
        const grant: ConnectorHostLocalGrant = await fixture.grant();
        const permit: ConnectorHostPermit = fixture.permit(
            grant,
            1n,
            ConnectorHostTool.FileWrite,
            '{"path":"unconfirmed.txt","mode":"create","encoding":"utf8","data":"secret"}',
        );
        {
            const owner: ConnectorPrivateDirectory = await ConnectorPrivateDirectory.open(
                ConnectorHostGrant.directory(fixture.identity),
                ConnectorDirectoryPurpose.Installation,
            );
            await using journal: ConnectorHostJournal = await ConnectorHostJournal.load(
                owner,
                fixture.identity,
                grant,
            );
            expect(await journal.begin(permit)).toBe(true);
        }
        const host: ConnectorClientHost = await fixture.open();
        const result: ConnectorHostCompletion = await host.execute(
            permit,
            permit.leaseId,
            permit.expiresAtMs,
        );
        expect(result.response.outcome).toBe(ConnectorHostOutcome.Indeterminate);
        expect(await readdir(fixture.tasks)).toEqual([]);
        await host.acknowledge(fixture.acknowledgment(result), permit.leaseId);
        expect(host.journal.snapshot.acknowledgedSequence).toBe(1n);
    },
);

it.skipIf(process.platform !== 'linux')(
    'a re-delivered Started original with no running operation and no response is answered as interrupted instead of retiring the socket',
    async (): Promise<void> => {
        await using fixture: ConnectorHostFixture = await ConnectorHostFixture.create();
        const grant: ConnectorHostLocalGrant = await fixture.grant();
        const permit: ConnectorHostPermit = fixture.permit(
            grant,
            1n,
            ConnectorHostTool.FileWrite,
            '{"path":"interrupted.txt","mode":"create","encoding":"utf8","data":"secret"}',
        );
        const host: ConnectorClientHost = await fixture.open();
        expect(await host.journal.begin(permit)).toBe(true);
        const result: ConnectorHostCompletion = await host.execute(
            permit,
            permit.leaseId,
            permit.expiresAtMs,
        );
        expect(result.response).toEqual({
            outcome: ConnectorHostOutcome.Indeterminate,
            resultJson: null,
            errorCode: ConnectorHostErrorCode.Interrupted,
        });
        expect(await readdir(fixture.tasks)).toEqual([]);
        expect((await host.execute(permit, permit.leaseId, permit.expiresAtMs)).response).toEqual(
            result.response,
        );
        await host.acknowledge(fixture.acknowledgment(result), permit.leaseId);
        expect(host.journal.snapshot.acknowledgedSequence).toBe(1n);
    },
);

it.skipIf(process.platform !== 'linux')(
    'disabled consent drains an old original without executing and preserves permanent journal identity',
    async (): Promise<void> => {
        await using fixture: ConnectorHostFixture = await ConnectorHostFixture.create();
        const original: ConnectorHostLocalGrant = await fixture.grant();
        const disabled: ConnectorHostLocalGrant = await fixture.grant(false);
        expect(disabled.journalId).toBe(original.journalId);
        expect(disabled.profile.grantId).toBe(original.profile.grantId);
        expect(disabled.profile.grantRevision).toBe(2n);
        const host: ConnectorClientHost = await fixture.open();
        const permit: ConnectorHostPermit = fixture.permit(
            original,
            1n,
            ConnectorHostTool.DirectoryCreate,
            '{"path":"forbidden","recursive":false}',
        );
        const result: ConnectorHostCompletion = await host.execute(
            permit,
            permit.leaseId,
            permit.expiresAtMs,
        );
        expect(result.response.outcome).toBe(ConnectorHostOutcome.Failed);
        expect(await readdir(fixture.tasks)).toEqual([]);
        await host.acknowledge(fixture.acknowledgment(result), permit.leaseId);
    },
);

it.skipIf(process.platform !== 'linux')(
    'lost or tampered host journal history cannot become a fresh grant or empty sequence',
    async (): Promise<void> => {
        await using fixture: ConnectorHostFixture = await ConnectorHostFixture.create();
        const grant: ConnectorHostLocalGrant = await fixture.grant();
        const file: string = join(ConnectorHostGrant.directory(fixture.identity), 'host-journal');
        const original: Buffer = await readFile(file);
        await writeFile(file, '{"nonce":"tampered"}', { mode: 0o600 });
        await expect(ConnectorClientHost.load(fixture.identity)).rejects.toThrow();
        await expect(fixture.grant()).rejects.toThrow();
        expect((await ConnectorHostGrant.read(fixture.identity))?.profile.grantRevision).toBe(
            grant.profile.grantRevision,
        );
        await writeFile(file, original, { mode: 0o600 });
        await rm(file);
        await expect(fixture.grant()).rejects.toThrow('missing');
        expect(
            ConnectorHostCodec.encode((await ConnectorHostGrant.read(fixture.identity))?.profile),
        ).toBe(ConnectorHostCodec.encode(grant.profile));
    },
);

it.skipIf(process.platform !== 'linux')(
    'a permit Nerva issued just ahead of a lagging local clock runs, and one beyond the handshake lead is denied',
    async (): Promise<void> => {
        await using fixture: ConnectorHostFixture = await ConnectorHostFixture.create();
        const grant: ConnectorHostLocalGrant = await fixture.grant();
        await writeFile(join(fixture.tasks, 'note.txt'), 'hello');
        const host: ConnectorClientHost = await fixture.open();
        const ahead: (sequence: bigint, leadMs: bigint) => ConnectorHostPermit = (
            sequence: bigint,
            leadMs: bigint,
        ): ConnectorHostPermit => {
            const permit: ConnectorHostPermit = fixture.permit(
                grant,
                sequence,
                ConnectorHostTool.FileRead,
                '{"path":"note.txt"}',
            );
            const { signature: _signature, ...unsigned } = permit;
            return fixture.sign({
                ...unsigned,
                issuedAtMs: unsigned.issuedAtMs + leadMs,
                expiresAtMs: unsigned.issuedAtMs + leadMs + 10000n,
            });
        };
        const lagging: ConnectorHostPermit = ahead(1n, 1100n);
        const completion: ConnectorHostCompletion = await host.execute(
            lagging,
            lagging.leaseId,
            lagging.expiresAtMs,
        );
        expect(completion.response.outcome).toBe(ConnectorHostOutcome.Succeeded);
        const early: ConnectorHostPermit = ahead(2n, 6000n);
        await expect(host.execute(early, early.leaseId, early.expiresAtMs)).rejects.toThrow(
            'Paired host permit denied',
        );
    },
);

it.skipIf(process.platform !== 'linux')(
    'an original that arrives after its start deadline is answered as expired, never runs, and stays expired when delivered again',
    async (): Promise<void> => {
        await using fixture: ConnectorHostFixture = await ConnectorHostFixture.create();
        const grant: ConnectorHostLocalGrant = await fixture.grant();
        const host: ConnectorClientHost = await fixture.open();
        const append: string = JSON.stringify({
            path: 'stale.txt',
            mode: 'append',
            encoding: 'utf8',
            data: 'must never be written\n',
        });
        const { signature: _signature, ...unsigned } = fixture.permit(
            grant,
            1n,
            ConnectorHostTool.FileWrite,
            append,
        );
        const late: ConnectorHostPermit = fixture.sign({
            ...unsigned,
            startByMs: unsigned.issuedAtMs - 1n,
        });
        const expired: ConnectorHostCompletion = await host.execute(
            late,
            late.leaseId,
            late.expiresAtMs,
        );
        expect(expired.response).toEqual({
            outcome: ConnectorHostOutcome.Failed,
            resultJson: null,
            errorCode: ConnectorHostErrorCode.Expired,
        });
        await expect(readFile(join(fixture.tasks, 'stale.txt'), 'utf8')).rejects.toThrow('ENOENT');
        const again: ConnectorHostCompletion = await host.execute(
            fixture.sign({
                ...unsigned,
                startByMs: late.startByMs,
                issuedAtMs: BigInt(Date.now()),
            }),
            late.leaseId,
            late.expiresAtMs,
        );
        expect(again.response).toEqual(expired.response);
        await host.acknowledge(fixture.acknowledgment(again), late.leaseId);
        const next: ConnectorHostPermit = fixture.permit(
            grant,
            2n,
            ConnectorHostTool.FileWrite,
            append.replace('must never be written', 'runs in time'),
            late.leaseId,
        );
        const ran: ConnectorHostCompletion = await host.execute(
            next,
            next.leaseId,
            next.expiresAtMs,
        );
        expect(ran.response.outcome).toBe(ConnectorHostOutcome.Succeeded);
        expect(await readFile(join(fixture.tasks, 'stale.txt'), 'utf8')).toBe('runs in time\n');
    },
);
