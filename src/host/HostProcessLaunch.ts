// SPDX-FileCopyrightText: 2026 Dacely <business@dacely.com>
// SPDX-License-Identifier: LicenseRef-Proprietary

import { join } from 'node:path';
import { ConnectorHostErrorCode } from 'nerva-connector-protocol/protocol/ConnectorHost.js';
import { ConnectorHostShell } from 'nerva-connector-protocol/protocol/ConnectorHostArgumentChoices.js';
import { HostOperationError } from './HostOperationError.js';
import type { HostProcessRequest } from './HostWorkspaceTypes.js';

/** Prepared arguments preserve the distinction between shell syntax and an executable argument vector. */
export interface HostProcessLaunchOptions {
    readonly executable: string;
    readonly arguments: readonly string[];
    readonly windowsVerbatimArguments: boolean;
}

/** Shell mappings use installed user programs; this layer neither downloads tools nor claims to sandbox them. */
export class HostProcessLaunch {
    /**
     * Native PowerShell encoding avoids command-line quoting reinterpretation.
     *
     * @remarks
     * Preparation runs before any process is created, so each refusal is definitive.
     */
    public static prepare(
        request: HostProcessRequest,
        platform: NodeJS.Platform = process.platform,
    ): HostProcessLaunchOptions {
        if (request.shell === null) {
            if (request.executable === null) {
                throw new HostOperationError(
                    ConnectorHostErrorCode.InvalidRequest,
                    'Executable mode requires executable',
                    true,
                );
            }
            return {
                executable: request.executable,
                arguments: request.arguments,
                windowsVerbatimArguments: false,
            };
        }
        if (request.command === null) {
            throw new HostOperationError(
                ConnectorHostErrorCode.InvalidRequest,
                'Shell mode requires command',
                true,
            );
        }
        if (request.shell === ConnectorHostShell.Cmd) {
            if (platform !== 'win32') {
                throw new HostOperationError(
                    ConnectorHostErrorCode.Unsupported,
                    'The cmd shell requires Windows',
                    true,
                );
            }
            const systemRoot: string | undefined = process.env['SystemRoot'];
            if (systemRoot === undefined || !/^[A-Za-z]:\\/u.test(systemRoot)) {
                throw new HostOperationError(
                    ConnectorHostErrorCode.Unsupported,
                    'Windows SystemRoot is unavailable to locate cmd.exe',
                    true,
                );
            }
            return {
                executable: join(systemRoot, 'System32', 'cmd.exe'),
                arguments: ['/d', '/s', '/c', '"' + request.command + '"'],
                windowsVerbatimArguments: true,
            };
        }
        if (
            request.shell === ConnectorHostShell.PowerShell ||
            request.shell === ConnectorHostShell.Pwsh
        ) {
            return {
                executable: request.shell === ConnectorHostShell.Pwsh ? 'pwsh' : 'powershell.exe',
                arguments: [
                    '-NoLogo',
                    '-NoProfile',
                    '-NonInteractive',
                    '-EncodedCommand',
                    Buffer.from(request.command, 'utf16le').toString('base64'),
                ],
                windowsVerbatimArguments: false,
            };
        }
        return {
            executable: request.shell,
            arguments: ['-c', request.command],
            windowsVerbatimArguments: false,
        };
    }
}
