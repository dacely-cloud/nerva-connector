// SPDX-FileCopyrightText: 2026 Nerva contributors
// SPDX-License-Identifier: LicenseRef-Proprietary

import { HostWorkspace } from '../host/HostWorkspace.js';
import { HostMcpWorkspaceTools } from '../host/HostMcpWorkspaceTools.js';
import { HostMcpServer } from '../host/HostMcpServer.js';
import { HostWindowsBuild } from '../host/HostWindowsBuild.js';
import type {
    HostWorkspaceAuthorization,
    HostWorkspaceAccess,
} from '../host/HostWorkspaceTypes.js';

/** Explicit launch grants host-user access only to this stdio session and its owned processes. */
class HostMcpGrant implements HostWorkspaceAuthorization {
    public constructor(public readonly signal: AbortSignal) {}

    /** Aborted session authority never admits another host operation. */
    public authorize(_access: HostWorkspaceAccess): Promise<void> {
        this.signal.throwIfAborted();
        return Promise.resolve();
    }
}

/** Local MCP entrypoint requires a visible full-computer grant on every launch. */
export class HostMcpCommand {
    /** No listen socket, stored permission change, pairing change or implicit cloud grant is created. */
    public static async run(args: readonly string[], signal: AbortSignal): Promise<void> {
        if (
            args.length !== 4 ||
            args[0] !== 'host-mcp' ||
            args[1] !== '--full-computer-access' ||
            args[2] !== '--directory' ||
            args[3] === undefined
        ) {
            throw new Error(
                'Use nexa connector host-mcp --full-computer-access --directory <absolute directory>',
            );
        }
        const windowsLauncher: string | undefined =
            process.platform === 'win32' ? await HostWindowsBuild.verifiedExecutable() : undefined;
        await using workspace: HostWorkspace = await HostWorkspace.create({
            directory: args[3],
            authorization: new HostMcpGrant(signal),
            ...(windowsLauncher === undefined ? {} : { windowsLauncher }),
        });
        process.stderr.write(
            'Full-computer MCP access is active for this stdio session with your OS user permissions.\n',
        );
        await new HostMcpServer(
            new HostMcpWorkspaceTools(
                workspace,
                signal,
                undefined,
                await workspace.terminals.available(),
            ),
            process.stdin,
            process.stdout,
        ).run(signal);
    }
}
