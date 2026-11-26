// SPDX-FileCopyrightText: 2026 Dacely <business@dacely.com>
// SPDX-License-Identifier: LicenseRef-Proprietary

import { dirname, join, resolve } from 'node:path';
import {
    ConnectorInstallation,
    type ConnectorInstallationView,
} from '../install/ConnectorInstallation.js';
import { ConnectorReleaseCodec } from '../install/ConnectorReleaseCodec.js';
import {
    type ConnectorReleaseArtifact,
    ConnectorReleaseFile,
} from '../install/ConnectorRelease.js';
import { ConnectorCapabilityState } from '../install/ConnectorCapabilityState.js';
import { ConnectorCapabilityInstallation } from '../install/ConnectorCapabilityInstallation.js';
import {
    ConnectorClientConfiguration,
    type ConnectorClientIdentity,
} from '../runtime/ConnectorClientConfiguration.js';
import {
    ConnectorPrivateDirectory,
    ConnectorDirectoryPurpose,
} from '../runtime/ConnectorPrivateDirectory.js';
import { ConnectorFileRoots } from '../runtime/ConnectorFileRoots.js';
import { ConnectorFileMode } from 'nerva-connector-protocol/protocol/ConnectorFiles.js';
import { Boundary } from 'nerva-connector-protocol/protocol/Boundary.js';
import { ProtectedFiles } from '../local/ProtectedFiles.js';
import {
    ConnectorPermissionError,
    ConnectorPermissionFailure,
} from './ConnectorPermissionError.js';

/** A local approval captures one existing folder and its explicit access, never a cloud-supplied path. */
export interface ConnectorFileApproval {
    readonly bindingSha256: string;
    readonly path: string;
    readonly mode: ConnectorFileMode;
}
/** Public installation commitments are sufficient for a review; private device material never leaves its loader owner. */
export interface ConnectorFileGrantContext {
    readonly directory: string;
    readonly helperFile: string;
    readonly helperSha256: string;
    readonly bindingSha256: string;
    readonly retained: ConnectorFileApproval | null;
}

/** Local review generates bounded protected inputs for the existing signed-installation capability installer. */
export class ConnectorFileGrant {
    /** Inspection does not create files, grant access, pair a device or acquire an active journal owner. */
    public static async inspect(
        directory: string,
        signal: AbortSignal,
    ): Promise<ConnectorFileGrantContext> {
        signal.throwIfAborted();
        if (process.platform !== 'linux') {
            throw new ConnectorPermissionError(ConnectorPermissionFailure.Platform);
        }
        if (!(await ProtectedFiles.exists(join(directory, 'ready.json')))) {
            throw new ConnectorPermissionError(ConnectorPermissionFailure.Release);
        }
        const installed: ConnectorInstallationView = await ConnectorInstallation.read(
            directory,
            signal,
        );
        if (!installed.enrolled) {
            throw new ConnectorPermissionError(ConnectorPermissionFailure.Pairing);
        }
        const runtime: ConnectorClientIdentity = await ConnectorClientConfiguration.load(
            installed.runtimeFile,
        );
        using keys: DisposableStack = new DisposableStack();
        keys.use(runtime.key);
        const helperSha256: string | undefined = installed.release.manifest.artifacts.find(
            (artifact: ConnectorReleaseArtifact): boolean =>
                artifact.name === ConnectorReleaseFile.Files,
        )?.sha256;
        if (helperSha256 === undefined) {
            throw new ConnectorPermissionError(ConnectorPermissionFailure.Release);
        }
        const bindingSha256: string = ConnectorCapabilityState.hash(
            JSON.stringify([
                ConnectorReleaseCodec.encode(installed.release),
                installed.publicKey,
                runtime.settings.enrollmentId,
                runtime.settings.environmentId,
            ]),
        );
        const approvalFile: string = join(directory, 'permissions', 'approval.json');
        const retained: ConnectorFileApproval | null = (await ProtectedFiles.exists(approvalFile))
            ? this.#approval(
                  JSON.parse(
                      new TextDecoder('utf-8', { fatal: true }).decode(
                          await ProtectedFiles.readPrivate(approvalFile, 16384),
                      ),
                  ),
              )
            : null;
        if (retained !== null && retained.bindingSha256 !== bindingSha256) {
            throw new ConnectorPermissionError(ConnectorPermissionFailure.Changed);
        }
        if (
            retained === null &&
            (runtime.settings.files !== null || runtime.settings.execution !== null)
        ) {
            throw new ConnectorPermissionError(ConnectorPermissionFailure.Existing);
        }
        signal.throwIfAborted();
        return Object.freeze({
            directory,
            helperFile: join(directory, ConnectorReleaseFile.Files),
            helperSha256,
            bindingSha256,
            retained,
        });
    }

    /** Review checks the selected folder without creating staging, policy, approval or journal files. */
    public static async review(
        context: ConnectorFileGrantContext,
        path: string,
        mode: ConnectorFileMode,
    ): Promise<ConnectorFileApproval> {
        const approval: ConnectorFileApproval = this.#approval({
            bindingSha256: context.bindingSha256,
            path: resolve(ProtectedFiles.path(path)),
            mode,
        });
        if (
            approval.path === context.directory ||
            approval.path.startsWith(context.directory + '/') ||
            context.directory.startsWith(approval.path + '/')
        ) {
            throw new ConnectorPermissionError(ConnectorPermissionFailure.Path);
        }
        try {
            await using roots: ConnectorFileRoots = await ConnectorFileRoots.load(
                [{ id: 'workspace', path: approval.path }],
                ConnectorFileMode.ReadOnly,
                [context.directory],
            );
            if (roots.policies[0]?.path !== approval.path) {
                throw new ConnectorPermissionError(ConnectorPermissionFailure.Path);
            }
        } catch {
            throw new ConnectorPermissionError(ConnectorPermissionFailure.Path);
        }
        if (
            context.retained !== null &&
            JSON.stringify(context.retained) !== JSON.stringify(approval)
        ) {
            throw new ConnectorPermissionError(ConnectorPermissionFailure.Changed);
        }
        return approval;
    }

    /** Only a caller's explicit local approval invokes this mutation; retries preserve the original exact setup inputs. */
    public static async approve(
        context: ConnectorFileGrantContext,
        approval: ConnectorFileApproval,
        signal: AbortSignal,
    ): Promise<void> {
        const expected: ConnectorFileGrantContext = Object.freeze({ ...context });
        const captured: ConnectorFileApproval = this.#approval(approval);
        const current: ConnectorFileGrantContext = await this.inspect(expected.directory, signal);
        if (
            current.bindingSha256 !== expected.bindingSha256 ||
            captured.bindingSha256 !== current.bindingSha256
        ) {
            throw new ConnectorPermissionError(ConnectorPermissionFailure.Changed);
        }
        await this.review(current, captured.path, captured.mode);
        signal.throwIfAborted();
        const directory: string = join(expected.directory, 'permissions');
        await ProtectedFiles.createDirectory(directory);
        await using owner: ConnectorPrivateDirectory = await ConnectorPrivateDirectory.open(
            directory,
            ConnectorDirectoryPurpose.Installation,
        );
        const names: readonly string[] = await owner.list();
        const allowed: ReadonlySet<string> = new Set([
            'approval.json',
            'approval.json.partial',
            'files-policy.json',
            'files-policy.json.partial',
            'request.json',
            'request.json.partial',
        ]);
        if (
            names.some((name: string): boolean => !allowed.has(name)) ||
            (!(await owner.exists('approval.json')) &&
                names.some((name: string): boolean => name !== 'approval.json.partial'))
        ) {
            throw new ConnectorPermissionError(ConnectorPermissionFailure.Changed);
        }
        const bytes: Buffer = Buffer.from(JSON.stringify(captured));
        await this.#retain(owner, 'approval.json', bytes);
        const stagingPath: string | null =
            captured.mode === ConnectorFileMode.ReadWrite
                ? join(
                      dirname(captured.path),
                      '.nexa-connector-stage-' +
                          ConnectorCapabilityState.hash(
                              JSON.stringify([expected.directory, captured.path]),
                          ),
                  )
                : null;
        if (stagingPath !== null) {
            signal.throwIfAborted();
            await ProtectedFiles.createDirectory(stagingPath);
            await using staging: ConnectorPrivateDirectory = await ConnectorPrivateDirectory.open(
                stagingPath,
                ConnectorDirectoryPurpose.Installation,
            );
            if (!(await staging.exists('approval.json')) && (await staging.list()).length !== 0) {
                throw new ConnectorPermissionError(ConnectorPermissionFailure.Changed);
            }
            await this.#retain(staging, 'approval.json', bytes);
        }
        const roots: readonly GrantRoot[] = [
            {
                id: 'workspace',
                path: captured.path,
                ...(stagingPath === null ? {} : { stagingPath }),
            },
        ];
        const policy: Buffer = Buffer.from(
            JSON.stringify({
                mode: captured.mode,
                revision: '1',
                helperFile: current.helperFile,
                helperSha256: current.helperSha256,
                roots,
            }),
        );
        await this.#retain(owner, 'files-policy.json', policy);
        await this.#retain(
            owner,
            'request.json',
            Buffer.from(
                JSON.stringify({
                    installationDirectory: expected.directory,
                    filesPolicyFile: owner.file('files-policy.json'),
                    executionPolicyFile: null,
                }),
            ),
        );
        signal.throwIfAborted();
        await ConnectorCapabilityInstallation.install(owner.file('request.json'), signal);
    }
    static #approval(raw: unknown): ConnectorFileApproval {
        const value: Readonly<Record<string, unknown>> = Boundary.record(raw, [
            'bindingSha256',
            'path',
            'mode',
        ]);
        const mode: ConnectorFileMode | undefined = Object.values(ConnectorFileMode).find(
            (entry: ConnectorFileMode): boolean => entry === value['mode'],
        );
        const digest: unknown = value['bindingSha256'];
        const path: string = ProtectedFiles.path(value['path']);
        if (
            mode === undefined ||
            typeof digest !== 'string' ||
            !/^[a-f0-9]{64}$/u.test(digest) ||
            resolve(path) !== path ||
            path === '/' ||
            /[\p{Cc}\p{Cf}]/u.test(path) ||
            path.endsWith('/')
        ) {
            throw new ConnectorPermissionError(ConnectorPermissionFailure.Path);
        }
        return Object.freeze({ bindingSha256: digest, path, mode });
    }
    static async #retain(
        owner: ConnectorPrivateDirectory,
        name: string,
        bytes: Buffer,
    ): Promise<void> {
        if (await owner.exists(name)) {
            if (!(await owner.read(name, 16384)).equals(bytes)) {
                throw new ConnectorPermissionError(ConnectorPermissionFailure.Changed);
            }
        } else {
            await owner.cleanPartial(name, 16384);
            await owner.write(name, bytes, 16384, true);
        }
    }
}

/** Read-only policies omit staging entirely; read/write policies name one private sibling on the selected filesystem. */
interface GrantRoot {
    readonly id: string;
    readonly path: string;
    readonly stagingPath?: string;
}
