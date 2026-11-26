// SPDX-FileCopyrightText: 2026 Dacely <business@dacely.com>
// SPDX-License-Identifier: LicenseRef-Proprietary

import { mkdir, writeFile, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import { ConnectorServiceFixture } from './ConnectorServiceFixture.js';
import { ConnectorFileMode } from 'nerva-connector-protocol/protocol/ConnectorFiles.js';
import type { ConnectorCapabilityRequest } from '../../src/install/ConnectorCapabilityPlan.js';

/** Signed real helper bytes are installed normally; no kernel execution policy or real service is changed by file-only tests. */
export class ConnectorCapabilityFixture implements AsyncDisposable {
    private constructor(
        public readonly service: ConnectorServiceFixture,
        public readonly workspace: string,
        public readonly policyFile: string,
        public readonly requestFile: string,
    ) {}
    /** File policy and workspace are separate from protected installation authority. */
    public static async create(): Promise<ConnectorCapabilityFixture> {
        const service: ConnectorServiceFixture = await ConnectorServiceFixture.create(true);
        try {
            const workspace: string = join(service.release.directory, 'project');
            const staging: string = join(service.release.directory, 'staging');
            await mkdir(workspace, { mode: 0o700 });
            await mkdir(staging, { mode: 0o700 });
            const policyFile: string = join(service.release.directory, 'files-policy.json');
            const requestFile: string = join(
                service.release.directory,
                'capabilities-request.json',
            );
            const helper: string = join(
                service.layout.installationDirectory,
                'nerva-connector-files',
            );
            await writeFile(
                policyFile,
                JSON.stringify({
                    mode: ConnectorFileMode.ReadWrite,
                    revision: '1',
                    helperFile: helper,
                    helperSha256: createHash('sha256')
                        .update(await readFile(helper))
                        .digest('hex'),
                    roots: [{ id: 'project', path: workspace, stagingPath: staging }],
                }),
                { mode: 0o600 },
            );
            const request: ConnectorCapabilityRequest = {
                installationDirectory: service.layout.installationDirectory,
                filesPolicyFile: policyFile,
                executionPolicyFile: null,
            };
            await writeFile(requestFile, JSON.stringify(request), { mode: 0o600 });
            return new ConnectorCapabilityFixture(service, workspace, policyFile, requestFile);
        } catch (caught: unknown) {
            await service[Symbol.asyncDispose]();
            throw caught;
        }
    }
    /** One normal installed device reference is retained across setup, interruption and exact repeats. */
    public get runtimeFile(): string {
        return join(this.service.layout.installationDirectory, 'state', 'device.json');
    }
    /** Tests observe the original encrypted journal without decoding or resetting its sequence. */
    public get journalFile(): string {
        return join(
            this.service.layout.installationDirectory,
            'capabilities',
            'files',
            'file-journal',
        );
    }
    /** All intentional installed helper/runtime bytes and test keys disappear with the one original fixture. */
    public async [Symbol.asyncDispose](): Promise<void> {
        await this.service[Symbol.asyncDispose]();
    }
}
