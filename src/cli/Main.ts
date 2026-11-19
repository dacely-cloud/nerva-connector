// SPDX-FileCopyrightText: 2026 Nerva contributors
// SPDX-License-Identifier: LicenseRef-Proprietary

import { ProtectedFiles } from '../local/ProtectedFiles.js';
import { WindowsUpdateFetch } from '../windows/WindowsUpdateFetch.js';
import { WindowsUpdateFetchError } from '../windows/WindowsUpdateFetchError.js';
import { HostMcpCommand } from './HostMcpCommand.js';
import { ConnectorHostAccessCommand } from './ConnectorHostAccessCommand.js';
import { ConnectorLogout } from '../runtime/ConnectorLogout.js';
import {
    JointWorkspaceInstallation,
    JointWorkspaceInstallationError,
    type JointWorkspaceInstallationReport,
} from '../workspace/JointWorkspaceInstallation.js';
import { SystemInfo } from '../system/SystemInfo.js';
import {
    ConnectorPermissionError,
    ConnectorPermissionFailure,
} from '../permissions/ConnectorPermissionError.js';
import { ConnectorPermissionPrompt } from './ConnectorPermissionPrompt.js';
import {
    ConnectorPermissionWizard,
    ConnectorPermissionOutcome,
    type ConnectorPermissionResult,
} from './ConnectorPermissionWizard.js';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { ConnectorCloudConfiguration } from '../runtime/ConnectorCloudConfiguration.js';
import { WindowsStateOwner } from '../windows/WindowsStateOwner.js';
import { WindowsStateError } from '../windows/WindowsStateProtocol.js';
import { ConnectorStartupDisplay } from './ConnectorStartupDisplay.js';
import {
    ConnectorNodeRuntime,
    ConnectorRuntimeUnsupported,
} from '../networking/ConnectorNodeRuntime.js';
import {
    ConnectorStartupStage,
    type ConnectorStartupProgress,
} from '../runtime/ConnectorStartup.js';
import { ConnectorConsoleApp } from './ConnectorConsoleApp.js';
import {
    ConnectorConsoleSourceKind,
    type ConnectorConsoleSource,
} from './ConnectorConsoleLocation.js';
import {
    SignatureSuite,
    type PublicIdentityRecord,
} from 'nerva-connector-protocol/identity/IdentityFormat.js';
import { ConnectorClient } from '../runtime/ConnectorClient.js';
import { ConnectorClientState } from '../runtime/ConnectorClientState.js';
import { ConnectorClientFiles } from '../runtime/ConnectorClientFiles.js';
import { ConnectorClientConfiguration } from '../runtime/ConnectorClientConfiguration.js';
import { ConnectorFilesystemCommand } from '../runtime/ConnectorFilesystemCommand.js';
import {
    ConnectorHistoryMigration,
    ConnectorHistoryMigrationError,
    type ConnectorHistoryMigrationReport,
} from '../runtime/ConnectorHistoryMigration.js';
import { ConnectorMigrationPreparation } from '../runtime/ConnectorMigrationPreparation.js';
import { ConnectorMigrationApprovalCodec } from 'nerva-connector-protocol/protocol/ConnectorMigrationApprovalCodec.js';
import {
    ConnectorMigrationLimits,
    type ConnectorMigrationApproval,
} from 'nerva-connector-protocol/protocol/ConnectorAdmissionMigration.js';
import {
    ConnectorPolicyPreparation,
    ConnectorPolicyPreparationError,
    type ConnectorPolicyPreparationReport,
} from '../runtime/ConnectorPolicyPreparation.js';
import { ConnectorDeviceKey } from '../runtime/ConnectorDeviceKey.js';
import { ConnectorJournalFormatError } from '../runtime/ConnectorJournalFormatError.js';
import { ConnectorNativeExecutionError } from '../runtime/ConnectorNativeExecutionError.js';
import {
    ConnectorPairClient,
    ConnectorPairEventKind,
    ConnectorPairIntent,
    type ConnectorPairEvent,
    type ConnectorPairCompleted,
} from '../runtime/ConnectorPairClient.js';
import { ExecutionJournalInstallation } from '../execution/ExecutionJournalInstallation.js';
import { ExecutionJobsCodec } from '../execution/ExecutionJobsCodec.js';
import { ConnectorReleaseInstallation } from '../install/ConnectorReleaseInstallation.js';
import { ConnectorServiceCli } from '../service/ConnectorServiceCli.js';
import { ConnectorServiceStatusCodec } from '../service/ConnectorServiceStatusCodec.js';
import { ConnectorCapabilityInstallation } from '../install/ConnectorCapabilityInstallation.js';
import { ConnectorNativeInstallation } from '../native/ConnectorNativeInstallation.js';
import { ConnectorConnectionLog } from '../runtime/ConnectorConnectionLog.js';
import {
    ConnectorInstallation,
    type ConnectorInstallationView,
} from '../install/ConnectorInstallation.js';
import {
    WorkspaceDiagnostic,
    WorkspaceCompatibility,
    type WorkspaceDiagnosticReport,
} from '../workspace/WorkspaceDiagnostic.js';

/** Named local entry points separate confined grants from explicitly authorized host-user MCP access. */
enum ConnectorLocalCommand {
    WindowsUpdateFetch = '--windows-update-fetch',
    Connector = 'connector',
    HostMcp = 'host-mcp',
    HostAccess = 'host-access',
    Service = 'service',
    ServiceRun = 'service-run',
    Connect = 'connect',
    Install = 'install',
    InstallCapabilities = 'install-capabilities',
    InstallNative = 'install-native',
    Pair = 'pair',
    Logout = 'logout',
    RenewPairing = 'renew-pairing',
    Run = 'run',
    SystemInfo = 'system-info',
    Help = '--help',
    Status = 'status',
    Permissions = 'permissions',
    InitializeIdentity = 'initialize-identity',
    Files = 'files',
    InitializeFiles = 'initialize-files',
    InitializeExecution = 'initialize-execution',
    InspectWorkspace = 'inspect-workspace',
    PreparePolicyChange = 'prepare-policy-change',
    MigrateHistory = 'migrate-history',
    PrepareHistoryMigration = 'prepare-history-migration',
    InitializeWorkspaces = 'initialize-workspaces',
}

/** Standalone connector entry points load no account, backend or host-management credentials; file mode uses only its reviewed confined helper. */
const invocation: readonly string[] = process.argv.slice(2);
const cloud: boolean =
    invocation.length === 1 && invocation[0] === ConnectorLocalCommand.Connector.valueOf();
const args: readonly string[] = cloud
    ? [
          ConnectorLocalCommand.Connect,
          '--installation',
          process.platform === 'win32' ? '' : join(homedir(), '.local/share/nerva-connector'),
      ]
    : invocation[0] === ConnectorLocalCommand.Connector.valueOf()
      ? invocation.slice(1)
      : invocation;
const consoleSource: ConnectorConsoleSource | null =
    args.length === 3 &&
    args[0] === ConnectorLocalCommand.Connect.valueOf() &&
    (args[1] === '--config' || args[1] === '--installation') &&
    args[2] !== undefined
        ? {
              kind: cloud
                  ? ConnectorConsoleSourceKind.Cloud
                  : args[1] === '--config'
                    ? ConnectorConsoleSourceKind.Pairing
                    : ConnectorConsoleSourceKind.Installation,
              path: args[2],
          }
        : null;
const stop: AbortController = new AbortController();
using progress: ConnectorStartupDisplay = new ConnectorStartupDisplay((text: string): void => {
    if (text !== '') {
        process.stderr.write(text + '\n');
    }
}, false);
process.once('SIGINT', (): void => stop.abort());
process.once('SIGTERM', (): void => stop.abort());
try {
    ConnectorNodeRuntime.assertCurrent();
    if (args.length === 1 && args[0] === ConnectorLocalCommand.WindowsUpdateFetch.valueOf()) {
        await WindowsUpdateFetch.command(process.stdin, process.stdout, stop.signal);
    } else if (args[0] === ConnectorLocalCommand.HostMcp.valueOf()) {
        await HostMcpCommand.run(args, stop.signal);
    } else if (args[0] === ConnectorLocalCommand.HostAccess.valueOf()) {
        await ConnectorHostAccessCommand.run(args, stop.signal);
    } else if (consoleSource !== null && process.stdin.isTTY && process.stdout.isTTY) {
        await new ConnectorConsoleApp(consoleSource).run(stop.signal);
    } else if (args[0] === ConnectorLocalCommand.Logout.valueOf()) {
        if (!(
            args.length === 1 ||
            (args.length === 3 &&
                (args[1] === '--config' || args[1] === '--installation') &&
                args[2] !== undefined)
        )) {
            throw new Error(
                'Usage: nexa connector logout [--config <pairingFile> | --installation <directory>]',
            );
        }
        const selected: string | undefined = args[2];
        const pairingFile: string =
            selected === undefined
                ? await ConnectorCloudConfiguration.prepare(
                      await ConnectorCloudConfiguration.defaultDirectory(),
                      stop.signal,
                  )
                : args[1] === '--installation'
                  ? (await ConnectorInstallation.read(selected, stop.signal)).pairingFile
                  : selected;
        await ConnectorLogout.run(pairingFile, stop.signal);
        process.stdout.write(
            'Machine removed from your account. Run nexa connector to get a new pairing code.\n',
        );
    } else if (
        args.length === 0 ||
        (args.length === 1 && args[0] === ConnectorLocalCommand.Help.valueOf())
    ) {
        process.stdout.write(
            [
                'Nerva Connector',
                '',
                'Usage:',
                '  nexa connector                Open the connector',
                '  nexa connector status         Check connection status',
                '  nexa connector logout         Unpair this machine and pair again',
                '  nexa connector permissions    Approve local Linux file access',
                '  nexa connector host-mcp --full-computer-access --directory <absolute directory>',
                '  nexa connector host-access --config <runtimeFile> --directory <existing tasks> --full-computer-access',
                '  nexa connector host-access --config <runtimeFile> --disable',
                '  nexa connector inspect-workspace --config <runtimeFile> --file-root <id> --execution-root <id>',
                '  nexa connector prepare-policy-change --config <runtimeFile>',
                '  nexa connector prepare-history-migration --config <runtimeFile>',
                '  nexa connector migrate-history --config <runtimeFile> --approval <protectedApprovalFile>',
                '  nexa connector initialize-workspaces --config <runtimeFile> --bindings <protectedMappingFile>',
                '  nexa connector system-info',
                '  nexa connector --help',
                '',
                'Your pairing code appears automatically when this machine is not linked.',
                'Type / inside the app for commands. Ctrl+C closes it.',
                '',
            ].join('\n'),
        );
    } else if (
        invocation[0] === ConnectorLocalCommand.Connector.valueOf() &&
        args.length === 5 &&
        args[0] === ConnectorLocalCommand.InitializeWorkspaces.valueOf() &&
        args[1] === '--config' &&
        args[2] !== undefined &&
        args[3] === '--bindings' &&
        args[4] !== undefined
    ) {
        const report: JointWorkspaceInstallationReport =
            await JointWorkspaceInstallation.initialize(args[2], args[4], stop.signal);
        process.stdout.write(
            JSON.stringify(report, (_key: string, value: unknown): unknown =>
                typeof value === 'bigint' ? value.toString() : value,
            ) + '\n',
        );
        process.stderr.write(
            'Workspace mappings are saved. Start the connector to finish setup.\n',
        );
    } else if (
        invocation[0] === ConnectorLocalCommand.Connector.valueOf() &&
        args.length === 3 &&
        args[0] === ConnectorLocalCommand.PrepareHistoryMigration.valueOf() &&
        args[1] === '--config' &&
        args[2] !== undefined
    ) {
        const plan: Awaited<ReturnType<typeof ConnectorMigrationPreparation.run>> =
            await ConnectorMigrationPreparation.run(args[2], stop.signal);
        process.stdout.write(
            JSON.stringify(plan, (_key: string, value: unknown): unknown =>
                typeof value === 'bigint' ? value.toString() : value,
            ) + '\n',
        );
        process.stderr.write(
            'Migration plan saved. Keep the connector stopped until the authority approves this exact plan.\n',
        );
    } else if (
        invocation[0] === ConnectorLocalCommand.Connector.valueOf() &&
        (args.length === 3 ||
            (args.length === 5 && args[3] === '--approval' && args[4] !== undefined)) &&
        args[0] === ConnectorLocalCommand.MigrateHistory.valueOf() &&
        args[1] === '--config' &&
        args[2] !== undefined
    ) {
        const approval: ConnectorMigrationApproval | null =
            args[4] === undefined
                ? null
                : ConnectorMigrationApprovalCodec.decode(
                      new TextDecoder('utf-8', { fatal: true }).decode(
                          await ProtectedFiles.readPrivate(
                              ProtectedFiles.path(args[4]),
                              ConnectorMigrationLimits.approvalBytes,
                          ),
                      ),
                  );
        const report: ConnectorHistoryMigrationReport = await ConnectorHistoryMigration.run(
            args[2],
            stop.signal,
            approval,
        );
        process.stdout.write(JSON.stringify(report) + '\n');
        process.stderr.write(
            'History migration grants no access and acknowledges no server work.\n',
        );
    } else if (
        invocation[0] === ConnectorLocalCommand.Connector.valueOf() &&
        args.length === 3 &&
        args[0] === ConnectorLocalCommand.PreparePolicyChange.valueOf() &&
        args[1] === '--config' &&
        args[2] !== undefined
    ) {
        const report: ConnectorPolicyPreparationReport = await ConnectorPolicyPreparation.prepare(
            args[2],
            stop.signal,
        );
        process.stdout.write(
            JSON.stringify(report, (_key: string, value: unknown): unknown =>
                typeof value === 'bigint' ? value.toString() : value,
            ) + '\n',
        );
        process.stderr.write(
            'Local preparation does not authorize a policy change; keep the original configuration until server work is acknowledged.\n',
        );
        if (!report.localReady) {
            process.exitCode = 1;
        }
    } else if (
        invocation[0] === ConnectorLocalCommand.Connector.valueOf() &&
        args.length === 7 &&
        args[0] === ConnectorLocalCommand.InspectWorkspace.valueOf() &&
        args[1] === '--config' &&
        args[2] !== undefined &&
        args[3] === '--file-root' &&
        args[4] !== undefined &&
        args[5] === '--execution-root' &&
        args[6] !== undefined
    ) {
        const report: WorkspaceDiagnosticReport = await WorkspaceDiagnostic.inspect(
            {
                configurationFile: args[2],
                fileRootId: args[4],
                executionRootId: args[6],
            },
            stop.signal,
        );
        if (stop.signal.aborted) {
            process.exitCode = 1;
        } else {
            process.stdout.write(JSON.stringify(report) + '\n');
            process.stderr.write('Inspection grants no joint Machine command capability.\n');
            if (report.status === WorkspaceCompatibility.Unavailable) {
                process.exitCode = 1;
            }
        }
    } else if (
        invocation[0] === ConnectorLocalCommand.Connector.valueOf() &&
        args[0] === ConnectorLocalCommand.Permissions.valueOf() &&
        (args.length === 1 ||
            (args.length === 3 && args[1] === '--installation' && args[2] !== undefined))
    ) {
        if (process.platform !== 'linux') {
            throw new ConnectorPermissionError(ConnectorPermissionFailure.Platform);
        }
        using questions: ConnectorPermissionPrompt = new ConnectorPermissionPrompt(stop.signal);
        const directory: string =
            args.length === 1
                ? await ConnectorCloudConfiguration.defaultDirectory()
                : ProtectedFiles.path(args[2]);
        const result: ConnectorPermissionResult = await ConnectorPermissionWizard.run(
            directory,
            questions,
            questions.signal,
        );
        if (result.outcome === ConnectorPermissionOutcome.Unavailable) {
            process.exitCode = 1;
        }
    } else if (
        invocation[0] === ConnectorLocalCommand.Connector.valueOf() &&
        args.length === 1 &&
        args[0] === ConnectorLocalCommand.Status.valueOf()
    ) {
        process.stdout.write(
            await ConnectorCloudConfiguration.status(
                await ConnectorCloudConfiguration.defaultDirectory(),
                stop.signal,
            ),
        );
    } else if (args[0] === ConnectorLocalCommand.Service.valueOf()) {
        process.stdout.write(
            JSON.stringify(
                ConnectorServiceStatusCodec.read(
                    await ConnectorServiceCli.command(args.slice(1), stop.signal, printPair),
                ),
            ) + '\n',
        );
    } else if (
        args.length === 5 &&
        args[0] === ConnectorLocalCommand.ServiceRun.valueOf() &&
        args[1] === '--directory' &&
        args[2] !== undefined &&
        args[3] === '--scope'
    ) {
        await ConnectorServiceCli.run(
            args[2],
            ConnectorServiceCli.scope(args[4]),
            stop.signal,
            printState,
        );
    } else if (
        args.length === 3 &&
        args[0] === ConnectorLocalCommand.Install.valueOf() &&
        args[1] === '--config' &&
        args[2] !== undefined
    ) {
        process.stdout.write(
            JSON.stringify(await ConnectorReleaseInstallation.install(args[2], stop.signal)) + '\n',
        );
    } else if (
        args.length === 3 &&
        args[0] === ConnectorLocalCommand.InstallCapabilities.valueOf() &&
        args[1] === '--config' &&
        args[2] !== undefined
    ) {
        process.stdout.write(
            JSON.stringify(await ConnectorCapabilityInstallation.install(args[2], stop.signal)) +
                '\n',
        );
    } else if (
        args.length === 3 &&
        args[0] === ConnectorLocalCommand.InstallNative.valueOf() &&
        args[1] === '--config' &&
        args[2] !== undefined
    ) {
        process.stdout.write(
            JSON.stringify(await ConnectorNativeInstallation.install(args[2], stop.signal)) + '\n',
        );
    } else if (args.length === 1 && args[0] === ConnectorLocalCommand.SystemInfo.valueOf()) {
        process.stdout.write(JSON.stringify(await SystemInfo.read(stop.signal)) + '\n');
    } else if (
        args.length === 3 &&
        (args[0] === ConnectorLocalCommand.Pair.valueOf() ||
            args[0] === ConnectorLocalCommand.RenewPairing.valueOf() ||
            args[0] === ConnectorLocalCommand.Connect.valueOf()) &&
        (args[1] === '--config' || args[1] === '--installation') &&
        args[2] !== undefined
    ) {
        progress.update({ stage: ConnectorStartupStage.LocalSecurity });
        const configurationFile: string = cloud
            ? await ConnectorCloudConfiguration.prepare(
                  args[2] === '' ? await ConnectorCloudConfiguration.defaultDirectory() : args[2],
                  stop.signal,
              )
            : args[1] === '--installation'
              ? (await ConnectorInstallation.read(args[2], stop.signal)).pairingFile
              : args[2];
        const completed: ConnectorPairCompleted | null = await pair(
            configurationFile,
            stop.signal,
            args[0] === ConnectorLocalCommand.RenewPairing.valueOf()
                ? ConnectorPairIntent.RenewExpired
                : ConnectorPairIntent.Resume,
        );
        if (completed === null && !stop.signal.aborted) {
            throw new Error('Connector pairing did not complete');
        }
        if (
            completed !== null &&
            args[0] === ConnectorLocalCommand.Connect.valueOf() &&
            !stop.signal.aborted
        ) {
            await run(completed.configurationFile, stop.signal);
        }
    } else if (
        args.length === 3 &&
        args[1] === '--installation' &&
        args[2] !== undefined &&
        (args[0] === ConnectorLocalCommand.Status.valueOf() ||
            args[0] === ConnectorLocalCommand.SystemInfo.valueOf() ||
            args[0] === ConnectorLocalCommand.Run.valueOf())
    ) {
        const installation: ConnectorInstallationView = await ConnectorInstallation.read(
            args[2],
            stop.signal,
        );
        if (args[0] === ConnectorLocalCommand.Run.valueOf()) {
            if (!installation.enrolled) {
                throw new Error('Pair this machine first');
            }
            await run(installation.runtimeFile, stop.signal);
        } else if (args[0] === ConnectorLocalCommand.SystemInfo.valueOf()) {
            process.stdout.write(JSON.stringify(await SystemInfo.read(stop.signal)) + '\n');
        } else {
            process.stdout.write(
                installation.enrolled
                    ? 'Machine linked. Enrollment is saved; connectivity is confirmed when the connector runs.\n'
                    : 'Machine is installed but not linked. Run nexa connector to pair it.\n',
            );
        }
    } else if (
        args.length === 3 &&
        args[0] === ConnectorLocalCommand.InitializeIdentity.valueOf() &&
        args[1] === '--key-file' &&
        args[2] !== undefined
    ) {
        const publicKey: string = await ConnectorDeviceKey.initialize(args[2]);
        const descriptor: PublicIdentityRecord = {
            suite: SignatureSuite.MlDsa44Ed25519,
            publicKey,
        };
        process.stdout.write(JSON.stringify(descriptor) + '\n');
    } else if (
        args.length === 3 &&
        args[0] === ConnectorLocalCommand.Files.valueOf() &&
        args[1] === '--policy' &&
        args[2] !== undefined
    ) {
        await ConnectorFilesystemCommand.run(args[2], stop.signal);
    } else if (
        args.length === 3 &&
        args[0] === ConnectorLocalCommand.InitializeFiles.valueOf() &&
        args[1] === '--config' &&
        args[2] !== undefined
    ) {
        using owner: DisposableStack = new DisposableStack();
        const identity: Awaited<ReturnType<typeof ConnectorClientConfiguration.load>> =
            await ConnectorClientConfiguration.load(args[2]);
        owner.use(identity.key);
        await ConnectorClientFiles.initialize(identity);
    } else if (
        args.length === 5 &&
        args[0] === ConnectorLocalCommand.InitializeExecution.valueOf() &&
        args[1] === '--config' &&
        args[2] !== undefined &&
        args[3] === '--lane' &&
        args[4] !== undefined
    ) {
        using resources: DisposableStack = new DisposableStack();
        const identity: Awaited<ReturnType<typeof ConnectorClientConfiguration.load>> =
            await ConnectorClientConfiguration.load(args[2]);
        resources.use(identity.key);
        if (identity.settings.execution === null) {
            throw new Error('Explicit local execution grant required');
        }
        await ExecutionJournalInstallation.initialize(identity, {
            ...identity.settings.execution,
            lane: ExecutionJobsCodec.lane(args[4]),
        });
    } else {
        if (
            args.length !== 3 ||
            args[0] !== ConnectorLocalCommand.Run.valueOf() ||
            args[1] !== '--config' ||
            args[2] === undefined
        ) {
            throw new Error('Connector requires --config with a protected device configuration');
        }
        await run(args[2], stop.signal);
    }
} catch (caught: unknown) {
    progress.pause();
    const message: string =
        caught instanceof WindowsUpdateFetchError ||
        caught instanceof ConnectorRuntimeUnsupported ||
        caught instanceof WindowsStateError ||
        caught instanceof ConnectorPermissionError ||
        caught instanceof JointWorkspaceInstallationError ||
        caught instanceof ConnectorPolicyPreparationError ||
        caught instanceof ConnectorHistoryMigrationError ||
        caught instanceof ConnectorJournalFormatError ||
        caught instanceof ConnectorNativeExecutionError
            ? caught.message
            : (args[0] === ConnectorLocalCommand.HostMcp.valueOf() ||
                    args[0] === ConnectorLocalCommand.HostAccess.valueOf()) &&
                caught instanceof Error
              ? caught.message
              : args[0] === ConnectorLocalCommand.Logout.valueOf()
                ? 'Unpairing is not confirmed. Your pairing is preserved. Retry nexa connector logout when connected.'
                : 'Connector configuration or runtime failed';
    if (consoleSource !== null && !stop.signal.aborted) {
        const log: ConnectorConnectionLog = new ConnectorConnectionLog(
            ConnectorConnectionLog.location(),
        );
        log.record('startup-failed', {
            error: message,
            code: caught instanceof WindowsStateError ? caught.failure : null,
        });
        await log.flush();
    }
    process.stderr.write(message + '\n');
    process.exitCode = 1;
} finally {
    progress[Symbol.dispose]();
    await WindowsStateOwner.close();
}

/** Pairing and continuous setup share the same original state and public progress stream. */
async function pair(
    path: string,
    signal: AbortSignal,
    intent: ConnectorPairIntent,
): Promise<ConnectorPairCompleted | null> {
    let completed: ConnectorPairCompleted | null = null;
    await ConnectorPairClient.run(
        path,
        signal,
        (event: ConnectorPairEvent): void => {
            if (event.state === ConnectorPairEventKind.Paired) {
                completed = event;
            }
            printPair(event);
        },
        intent,
        (event: ConnectorStartupProgress): void => progress.update(event),
    );
    return completed;
}

/** One Node owner retains signal handling from setup through enrolled runtime shutdown. */
async function run(path: string, signal: AbortSignal): Promise<void> {
    const log: ConnectorConnectionLog = new ConnectorConnectionLog(
        ConnectorConnectionLog.location(),
    );
    try {
        await using client: ConnectorClient = await ConnectorClient.load(
            path,
            printState,
            (event: ConnectorStartupProgress): void => progress.update(event),
            signal,
            null,
            log,
        );
        await client.run(signal);
    } finally {
        await log.flush();
    }
}

/** Only public pairing events enter terminal output; no secret key or proof is printed. */
function printPair(event: ConnectorPairEvent): void {
    if (args[1] === '--installation') {
        process.stdout.write(
            event.state === ConnectorPairEventKind.Waiting
                ? '\nOpen ' +
                      event.verificationUri +
                      '\nEnter code: ' +
                      event.code +
                      '\nWaiting for your approval…\n'
                : event.state === ConnectorPairEventKind.Paired
                  ? 'Machine linked.\n'
                  : event.state === ConnectorPairEventKind.Expired
                    ? 'Pairing code expired. Run nexa connector renew-pairing.\n'
                    : 'Pairing: ' + event.state + '\n',
        );
        return;
    }
    process.stdout.write(
        JSON.stringify(event, (_key: string, value: unknown): unknown =>
            typeof value === 'bigint' ? value.toString() : value,
        ) + '\n',
    );
}
/** Runtime state never masquerades as a completed original command. */
function printState(state: ConnectorClientState): void {
    if (args[1] === '--installation') {
        process.stdout.write(
            state === ConnectorClientState.Authenticated
                ? 'Connected. Keep this terminal open, or install the background service.\n'
                : 'Connector: ' + state + '\n',
        );
        return;
    }
    process.stdout.write(JSON.stringify({ state }) + '\n');
}
