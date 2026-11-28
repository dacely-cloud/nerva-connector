// SPDX-FileCopyrightText: 2026 Dacely <business@dacely.com>
// SPDX-License-Identifier: LicenseRef-Proprietary

import { writeFile, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { expect, it } from 'vitest';
import {
    ConnectorHostTool,
    ConnectorHostOutcome,
    ConnectorHostErrorCode,
    type ConnectorHostResponse,
    type ConnectorHostPermit,
    type ConnectorHostCompletion,
} from 'nerva-connector-protocol/protocol/ConnectorHost.js';
import { ConnectorHostCodec } from 'nerva-connector-protocol/protocol/ConnectorHostCodec.js';
import { ConnectorHostFailure } from '../src/runtime/ConnectorHostFailure.js';
import { ConnectorConnectionLog } from '../src/runtime/ConnectorConnectionLog.js';
import { ConnectorHostProof } from '../src/runtime/ConnectorHostProof.js';
import { ConnectorHostFixture } from './support/ConnectorHostFixture.js';
import type { ConnectorClientHost } from '../src/runtime/ConnectorClientHost.js';
import type { ConnectorHostLocalGrant } from '../src/runtime/ConnectorHostGrantTypes.js';

/** Test errors model the same finite native errno boundary without exposing its message. */
class NativeFailure extends Error {
    public constructor(public readonly code: string) {
        super('private native diagnostic');
    }
}

it('public codes never turn a possibly partial mutation into definitive failure or expose diagnostics', (): void => {
    const observed: ConnectorHostResponse = ConnectorHostFailure.response(
        ConnectorHostTool.FileStat,
        new NativeFailure('ENOENT'),
    );
    expect(observed).toEqual({
        outcome: ConnectorHostOutcome.Failed,
        errorCode: ConnectorHostErrorCode.NotFound,
        resultJson: null,
    });
    const changed: ConnectorHostResponse = ConnectorHostFailure.response(
        ConnectorHostTool.FileWrite,
        new NativeFailure('EACCES'),
    );
    expect(changed.outcome).toBe(ConnectorHostOutcome.Indeterminate);
    expect(changed.errorCode).toBe(ConnectorHostErrorCode.PermissionDenied);
    expect(ConnectorHostCodec.encode([observed, changed])).not.toContain('private');
});

it('failure contracts require finite codes and bind them independently of caller property order', (): void => {
    const value: ConnectorHostResponse = {
        outcome: ConnectorHostOutcome.Failed,
        resultJson: null,
        errorCode: ConnectorHostErrorCode.NotFound,
    };
    expect(ConnectorHostProof.responseHash(value)).toBe(
        ConnectorHostProof.responseHash(ConnectorHostCodec.response(value)),
    );
    expect(ConnectorHostProof.responseHash(value)).not.toBe(
        ConnectorHostProof.responseHash({
            ...value,
            errorCode: ConnectorHostErrorCode.PermissionDenied,
        }),
    );
    for (const invalid of [
        { outcome: ConnectorHostOutcome.Failed, resultJson: null },
        { ...value, errorCode: 'private arbitrary error' },
        { ...value, errorCode: null },
        { ...value, outcome: ConnectorHostOutcome.Succeeded, resultJson: '{}' },
        { ...value, diagnostic: 'private' },
    ]) {
        expect((): ConnectorHostResponse => ConnectorHostCodec.response(invalid)).toThrow();
    }
});

it.skipIf(process.platform !== 'linux')(
    'missing native observations and exclusive collisions complete their same original with useful definitive codes',
    async (): Promise<void> => {
        await using fixture: ConnectorHostFixture = await ConnectorHostFixture.create();
        const grant: ConnectorHostLocalGrant = await fixture.grant();
        const log: ConnectorConnectionLog = new ConnectorConnectionLog(
            join(fixture.directory, 'logs', 'connection.log'),
        );
        const host: ConnectorClientHost = await fixture.open(null, log);
        await writeFile(join(fixture.tasks, 'existing.txt'), 'keep');
        const calls: readonly FailureCase[] = [
            {
                tool: ConnectorHostTool.FileStat,
                args: '{"path":"missing-private-token"}',
                code: ConnectorHostErrorCode.NotFound,
            },
            {
                tool: ConnectorHostTool.FileRead,
                args: '{"path":"missing-private-token"}',
                code: ConnectorHostErrorCode.NotFound,
            },
            {
                tool: ConnectorHostTool.DirectoryList,
                args: '{"path":"existing.txt"}',
                code: ConnectorHostErrorCode.NotDirectory,
            },
            {
                tool: ConnectorHostTool.ProcessRead,
                args: '{"processId":"00000000-0000-4000-8000-000000000000","stdoutOffset":"0","stderrOffset":"0","maximumBytes":1024}',
                code: ConnectorHostErrorCode.NotFound,
            },
            {
                tool: ConnectorHostTool.FileWrite,
                args: '{"path":"existing.txt","mode":"create","encoding":"utf8","data":"overwrite"}',
                code: ConnectorHostErrorCode.AlreadyExists,
            },
            {
                tool: ConnectorHostTool.FilePublish,
                args: '{"source":"existing.txt","destination":"existing.txt"}',
                code: ConnectorHostErrorCode.AlreadyExists,
            },
            {
                tool: ConnectorHostTool.FileRemove,
                args: '{"path":"missing-private-token","recursive":false}',
                code: ConnectorHostErrorCode.NotFound,
            },
            {
                tool: ConnectorHostTool.ProcessRead,
                args: '{"processId":"00000000-0000-4000-8000-000000000000","stdoutOffset":0,"stderrOffset":0}',
                code: ConnectorHostErrorCode.InvalidRequest,
            },
            {
                tool: ConnectorHostTool.FileWrite,
                args: '{"path":"existing.txt","mode":"update","encoding":"utf8","data":"private","offset":0}',
                code: ConnectorHostErrorCode.InvalidRequest,
            },
        ];
        let sequence: bigint = 0n;
        for (const entry of calls) {
            const permit: ConnectorHostPermit = fixture.permit(
                grant,
                ++sequence,
                entry.tool,
                entry.args,
            );
            const completion: ConnectorHostCompletion = await host.execute(
                permit,
                permit.leaseId,
                permit.expiresAtMs,
            );
            expect(completion.response).toEqual({
                outcome: ConnectorHostOutcome.Failed,
                resultJson: null,
                errorCode: entry.code,
            });
            expect(ConnectorHostCodec.encode(completion.response)).not.toContain('private');
            expect(
                (await host.execute(permit, permit.leaseId, permit.expiresAtMs)).response,
            ).toEqual(completion.response);
            await host.acknowledge(fixture.acknowledgment(completion), permit.leaseId);
        }
        expect(host.journal.snapshot.acknowledgedSequence).toBe(BigInt(calls.length));
        expect(await readFile(join(fixture.tasks, 'existing.txt'), 'utf8')).toBe('keep');
        const failures: readonly Readonly<Record<string, unknown>>[] = (
            await log.recent(50)
        ).filter(
            (line: Readonly<Record<string, unknown>>): boolean =>
                line['event'] === 'host-operation-failed',
        );
        expect(failures).toHaveLength(calls.length);
        expect(failures[6]).toMatchObject({
            tool: ConnectorHostTool.FileRemove,
            outcome: ConnectorHostOutcome.Failed,
            code: ConnectorHostErrorCode.NotFound,
            reason: 'Host removal path could not be examined',
            errorName: 'HostOperationError',
        });
        expect(failures[6]?.['cause']).toMatch(/^Error: ENOENT.*\[ENOENT lstat\]$/u);
        expect(failures[7]).toMatchObject({
            tool: ConnectorHostTool.ProcessRead,
            code: ConnectorHostErrorCode.InvalidRequest,
            reason: 'stdoutOffset must be a decimal integer string such as "0", not a JSON number',
        });
        expect(failures[8]).toMatchObject({
            tool: ConnectorHostTool.FileWrite,
            outcome: ConnectorHostOutcome.Failed,
            reason: 'offset must be a decimal integer string such as "0", not a JSON number',
        });
        for (const line of failures) {
            expect(line['reason']).not.toContain('The OS or local authority rejected');
        }
    },
);

/** Each real native case declares both its operation and exact expected public failure. */
interface FailureCase {
    readonly tool: ConnectorHostTool;
    readonly args: string;
    readonly code: ConnectorHostErrorCode;
}
