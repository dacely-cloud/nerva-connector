// SPDX-FileCopyrightText: 2026 Dacely <business@dacely.com>
// SPDX-License-Identifier: LicenseRef-Proprietary

import { HostOperationError } from '../host/HostOperationError.js';
import { HostDesktopError } from '../host/HostDesktopError.js';
import {
    ConnectorHostTool,
    ConnectorHostOutcome,
    type ConnectorHostResponse,
} from 'nerva-connector-protocol/protocol/ConnectorHost.js';

/** Public error codes and effect certainty remain separate; native diagnostics never cross the paired relay. */
export class ConnectorHostFailure {
    static readonly #observations: ReadonlySet<ConnectorHostTool> = new Set([
        ConnectorHostTool.ComputerInfo,
        ConnectorHostTool.NetworkResolve,
        ConnectorHostTool.EnvironmentInspect,
        ConnectorHostTool.FileRead,
        ConnectorHostTool.FileDigest,
        ConnectorHostTool.FileStat,
        ConnectorHostTool.DirectoryList,
        ConnectorHostTool.ProcessRead,
        ConnectorHostTool.TerminalRead,
        ConnectorHostTool.DesktopInfo,
        ConnectorHostTool.DesktopSnapshot,
    ]);

    /** Only observations or an operation owner's explicit pre-effect evidence establish definitive failure. */
    public static response(tool: ConnectorHostTool, caught: unknown): ConnectorHostResponse {
        return {
            outcome:
                this.#observations.has(tool) ||
                (caught instanceof HostOperationError && caught.definitive) ||
                (caught instanceof HostDesktopError && caught.definitive)
                    ? ConnectorHostOutcome.Failed
                    : ConnectorHostOutcome.Indeterminate,
            resultJson: null,
            errorCode: HostOperationError.code(caught),
        };
    }
}
