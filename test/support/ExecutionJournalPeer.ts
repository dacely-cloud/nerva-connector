// SPDX-FileCopyrightText: 2026 Nerva contributors
// SPDX-License-Identifier: LicenseRef-Proprietary

import { ExecutionConfiguration } from '../../src/execution/ExecutionConfiguration.js';
import { ExecutionPolicy } from '../../src/execution/ExecutionPolicy.js';
import { ExecutionJournalInstallation } from '../../src/execution/ExecutionJournalInstallation.js';
import { dirname, join } from 'node:path';
import { writeFile } from 'node:fs/promises';
import { Boundary } from 'nerva-connector-protocol/protocol/Boundary.js';
import { ProtectedFiles } from '../../src/local/ProtectedFiles.js';
import {
    ConnectorClientConfiguration,
    type ConnectorClientIdentity,
} from '../../src/runtime/ConnectorClientConfiguration.js';
import { ConnectorClientSession } from '../../src/runtime/ConnectorClientSession.js';
import { ConnectorDeviceCodec } from 'nerva-connector-protocol/protocol/ConnectorDeviceCodec.js';
import { ExecutionClient } from '../../src/execution/ExecutionClient.js';
import type { ExecutionClientSettings } from '../../src/execution/ExecutionClientSettings.js';
import { ExecutionPolicyCodec } from '../../src/execution/ExecutionPolicyCodec.js';
import {
    ExecutionAppArmorProfile,
    type ExecutionAppArmorDefinition,
} from '../../src/execution/ExecutionAppArmorProfile.js';
import { ExecutionAppArmorInstaller } from '../../src/execution/ExecutionAppArmorInstaller.js';
import { ExecutionJobsCodec } from '../../src/execution/ExecutionJobsCodec.js';
import type {
    ExecutionPermit,
    ExecutionCancellation,
    ExecutionCompletion,
    ExecutionAcknowledgment,
    ExecutionAcknowledged,
} from '../../src/execution/ExecutionJobs.js';
import { QualificationInput } from './QualificationInput.js';

/** Finite audited customer-only peer exercises normal dual authentication and durable command ownership over pinned SSH. */
enum ExecutionPeerAction {
    Initialize = 'initialize',
    Session = 'session',
    CancelSession = 'cancel-session',
}

const args: readonly string[] = process.argv.slice(2);
try {
    if (
        args.length !== 2 ||
        args[1] === undefined ||
        !Object.values(ExecutionPeerAction).some(
            (value: ExecutionPeerAction): boolean => value.valueOf() === args[0],
        )
    ) {
        throw new Error('Explicit signed execution peer action required');
    }
    const raw: unknown = JSON.parse(
        new TextDecoder('utf-8', { fatal: true }).decode(
            await ProtectedFiles.readPrivate(args[1], 16384),
        ),
    );
    const configuration: Readonly<Record<string, unknown>> = Boundary.record(raw, [
        'configurationFile',
        'policyFile',
        'stateDirectory',
        'lane',
    ]);
    const identity: ConnectorClientIdentity = await ConnectorClientConfiguration.load(
        ProtectedFiles.path(configuration['configurationFile']),
    );
    using resources: DisposableStack = new DisposableStack();
    resources.use(identity.key);
    const settings: ExecutionClientSettings = {
        lane: ExecutionJobsCodec.lane(configuration['lane']),
        policyFile: ProtectedFiles.path(configuration['policyFile']),
        stateDirectory: ProtectedFiles.path(configuration['stateDirectory']),
    };
    if (args[0] === ExecutionPeerAction.Initialize.valueOf()) {
        const policy: unknown = JSON.parse(
            new TextDecoder('utf-8', { fatal: true }).decode(
                await ProtectedFiles.readPrivate(settings.policyFile, 65536),
            ),
        );
        const definition: ReturnType<typeof ExecutionPolicyCodec.policy> =
            ExecutionPolicyCodec.policy(policy);
        const profile: ExecutionAppArmorDefinition = ExecutionAppArmorProfile.generate(definition);
        await writeFile(
            join(dirname(settings.policyFile), 'apparmor-profile.txt'),
            profile.source,
            { flag: 'wx', mode: 0o600 },
        );
        await ExecutionAppArmorInstaller.install(definition);
        await ExecutionJournalInstallation.initialize(identity, settings);
        process.stdout.write('initialized\n');
    } else {
        using session: ConnectorClientSession = new ConnectorClientSession(identity);
        process.stdout.write(ConnectorDeviceCodec.encode(session.begin(BigInt(Date.now()))) + '\n');
        const challenge: ReturnType<typeof ConnectorDeviceCodec.challenge> =
            ConnectorDeviceCodec.challenge(
                JSON.parse(
                    new TextDecoder('utf-8', { fatal: true }).decode(
                        await QualificationInput.read(),
                    ),
                ),
            );
        process.stdout.write(
            ConnectorDeviceCodec.encode(session.prove(challenge, BigInt(Date.now()))) + '\n',
        );
        session.confirm(
            ConnectorDeviceCodec.lease(
                JSON.parse(
                    new TextDecoder('utf-8', { fatal: true }).decode(
                        await QualificationInput.read(),
                    ),
                ),
            ),
            BigInt(Date.now()),
        );
        await using policy: ExecutionPolicy = await ExecutionConfiguration.loadPolicy(
            identity,
            settings,
        );
        await ExecutionAppArmorInstaller.assertInstalled(policy.definition);
        await using owner: ExecutionClient = await ExecutionClient.load(identity, settings, policy);
        process.stdout.write(ExecutionJobsCodec.encode(owner.publication(session)) + '\n');
        const permit: ExecutionPermit = ExecutionJobsCodec.permit(
            JSON.parse(
                new TextDecoder('utf-8', { fatal: true }).decode(await QualificationInput.read()),
            ),
        );
        const execution: Promise<ExecutionCompletion> = owner.execute(permit, session);
        const joined: Promise<readonly PromiseSettledResult<ExecutionCompletion>[]> =
            Promise.allSettled([execution]);
        if (args[0] === ExecutionPeerAction.CancelSession.valueOf()) {
            const cancellation: ExecutionCancellation = ExecutionJobsCodec.cancellation(
                JSON.parse(
                    new TextDecoder('utf-8', { fatal: true }).decode(
                        await QualificationInput.read(),
                    ),
                ),
            );
            const stopped: ExecutionCompletion = await owner.cancel(cancellation, session);
            const original: ExecutionCompletion = await execution;
            if (
                stopped.responseHash !== original.responseHash ||
                stopped.jobId !== original.jobId
            ) {
                throw new Error('Cancellation changed its original result');
            }
        }
        const completion: ExecutionCompletion = await execution;
        await joined;
        process.stdout.write(ExecutionJobsCodec.encode(completion) + '\n');
        const acknowledgment: ExecutionAcknowledgment = ExecutionJobsCodec.acknowledgment(
            JSON.parse(
                new TextDecoder('utf-8', { fatal: true }).decode(await QualificationInput.read()),
            ),
        );
        const receipt: ExecutionAcknowledged = await owner.acknowledge(acknowledgment, session);
        process.stdout.write(ExecutionJobsCodec.encode(receipt) + '\n');
    }
} catch {
    process.stderr.write('Signed execution qualification rejected\n');
    process.exitCode = 1;
}
process.stdin.destroy();
