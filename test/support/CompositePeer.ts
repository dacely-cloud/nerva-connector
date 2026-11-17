// SPDX-FileCopyrightText: 2026 Nerva contributors
// SPDX-License-Identifier: LicenseRef-Proprietary

import { dirname } from 'node:path';
import { open, lstat, type FileHandle } from 'node:fs/promises';
import { SigningKey } from '../../src/identity/SigningKey.js';
import { IdentityCodec } from 'nerva-connector-protocol/identity/IdentityCodec.js';
import {
    IdentityLengths,
    SignaturePurpose,
} from 'nerva-connector-protocol/identity/IdentityFormat.js';
import { ProtectedFiles } from '../../src/local/ProtectedFiles.js';
import { Boundary } from 'nerva-connector-protocol/protocol/Boundary.js';
import { ExchangeCodec } from 'nerva-connector-protocol/remote/ExchangeCodec.js';
import { type ExchangeContext } from 'nerva-connector-protocol/remote/ExchangeFormat.js';
import { SystemInfoOperation } from '../../src/remote/SystemInfoOperation.js';
import { QualificationInput } from './QualificationInput.js';
import { DeviceSession } from '../../src/remote/DeviceSession.js';

/** Test-only communication peer never contains the controller implementation or an infrastructure private key. */
enum PeerAction {
    Initialize = 'initialize',
    Session = 'session',
    Sign = 'sign',
}

try {
    const args: readonly string[] = process.argv.slice(2);
    if (args.length !== 2 || args[1] === undefined) {
        throw new Error('Qualification peer requires an explicit action and protected file');
    }
    if (args[0] === PeerAction.Initialize.valueOf()) {
        await ProtectedFiles.directory(dirname(ProtectedFiles.path(args[1])));
        using key: SigningKey = SigningKey.generate();
        const bytes: Buffer = key.encode();
        try {
            const file: FileHandle = await open(args[1], 'wx', 0o600);
            try {
                await file.writeFile(bytes);
                await file.sync();
            } finally {
                await file.close();
            }
        } finally {
            bytes.fill(0);
        }
        process.stdout.write(JSON.stringify({ publicKey: key.publicKey }) + '\n');
    } else if (args[0] === PeerAction.Session.valueOf() || args[0] === PeerAction.Sign.valueOf()) {
        const raw: unknown = JSON.parse(
            (await ProtectedFiles.readPrivate(args[1], 16384)).toString('utf8'),
        );
        const configuration: Readonly<Record<string, unknown>> = Boundary.record(
            raw,
            args[0] === PeerAction.Sign.valueOf()
                ? ['privateKeyFile', 'purpose', 'payload']
                : ['privateKeyFile', 'authorityPublicKey', 'context'],
        );
        const path: string = ProtectedFiles.path(configuration['privateKeyFile']);
        if ((await lstat(path, { bigint: true })).nlink !== 1n) {
            throw new Error('Qualification identity requires a single link');
        }
        const secret: Buffer = await ProtectedFiles.readPrivate(
            path,
            IdentityLengths.privateRecord,
        );
        try {
            using key: SigningKey = SigningKey.decode(secret);
            if (args[0] === PeerAction.Sign.valueOf()) {
                const purpose: SignaturePurpose | undefined = [
                    SignaturePurpose.DeviceEnrollment,
                    SignaturePurpose.DeviceHello,
                    SignaturePurpose.ClientAuthentication,
                ].find(
                    (entry: SignaturePurpose): boolean =>
                        entry.valueOf() === configuration['purpose'],
                );
                const text: unknown = configuration['payload'];
                if (purpose === undefined || typeof text !== 'string' || text.length > 10924) {
                    throw new Error('Unsupported qualification proof');
                }
                const payload: Buffer = Buffer.from(text, 'base64');
                if (
                    payload.byteLength === 0 ||
                    payload.byteLength > 8192 ||
                    payload.toString('base64') !== text
                ) {
                    throw new Error('Invalid qualification proof payload');
                }
                process.stdout.write(
                    JSON.stringify({
                        publicKey: key.publicKey,
                        signature: key.sign(purpose, payload),
                    }) + '\n',
                );
            } else {
                const context: ExchangeContext = ExchangeCodec.context(configuration['context']);
                const authorityPublicKey: string = IdentityCodec.publicKey(
                    configuration['authorityPublicKey'],
                ).toString('base64url');
                using session: DeviceSession = new DeviceSession(key, authorityPublicKey, context);
                process.stdout.write(JSON.stringify({ clientNonce: session.clientNonce }) + '\n');
                process.stdout.write(
                    ExchangeCodec.encode(
                        session.prove(await QualificationInput.read(), BigInt(Date.now())),
                    ),
                );
                process.stdout.write('\n');
                session.confirm(await QualificationInput.read(), BigInt(Date.now()));
                const result: Awaited<ReturnType<typeof SystemInfoOperation.execute>> =
                    await SystemInfoOperation.execute(
                        await QualificationInput.read(),
                        session,
                        AbortSignal.timeout(5000),
                    );
                process.stdout.write(ExchangeCodec.encode(result));
                process.stdout.write('\n');
            }
        } finally {
            secret.fill(0);
        }
    } else {
        throw new Error('Unsupported qualification action');
    }
} catch {
    process.stderr.write('Composite qualification rejected\n');
    process.exitCode = 1;
}

process.stdin.destroy();
