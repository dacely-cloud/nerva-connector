// SPDX-FileCopyrightText: 2026 Dacely <business@dacely.com>
// SPDX-License-Identifier: LicenseRef-Proprietary

import { join } from 'node:path';
import { HostShell, type HostProcessRequest } from './HostWorkspaceTypes.js';

/** Prepared arguments preserve the distinction between shell syntax and an executable argument vector. */
export interface HostProcessLaunchOptions {
    readonly executable: string;
    readonly arguments: readonly string[];
    readonly windowsVerbatimArguments: boolean;
}

/** Shell mappings use installed user programs; this layer neither downloads tools nor claims to sandbox them. */
export class HostProcessLaunch {
    /** Native PowerShell encoding avoids command-line quoting reinterpretation. */
    public static prepare(
        request: HostProcessRequest,
        platform: NodeJS.Platform = process.platform,
    ): HostProcessLaunchOptions {
        if (request.shell === null) {
            if (request.executable === null) {
                throw new Error('Host executable is required');
            }
            return {
                executable: request.executable,
                arguments: request.arguments,
                windowsVerbatimArguments: false,
            };
        }
        if (request.command === null) {
            throw new Error('Host shell command is required');
        }
        if (request.shell === HostShell.Cmd) {
            if (platform !== 'win32') {
                throw new Error('The cmd shell requires Windows');
            }
            const systemRoot: string | undefined = process.env['SystemRoot'];
            if (systemRoot === undefined || !/^[A-Za-z]:\\/u.test(systemRoot)) {
                throw new Error('Windows SystemRoot is unavailable');
            }
            return {
                executable: join(systemRoot, 'System32', 'cmd.exe'),
                arguments: ['/d', '/s', '/c', '"' + request.command + '"'],
                windowsVerbatimArguments: true,
            };
        }
        if (request.shell === HostShell.PowerShell || request.shell === HostShell.Pwsh) {
            return {
                executable: request.shell === HostShell.Pwsh ? 'pwsh' : 'powershell.exe',
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
