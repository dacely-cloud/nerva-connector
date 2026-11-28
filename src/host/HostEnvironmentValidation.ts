// SPDX-FileCopyrightText: 2026 Dacely <business@dacely.com>
// SPDX-License-Identifier: LicenseRef-Proprietary

import {
    ConnectorHostErrorCode,
    ConnectorHostTool,
} from 'nerva-connector-protocol/protocol/ConnectorHost.js';
import { ConnectorHostArgumentContracts } from 'nerva-connector-protocol/protocol/ConnectorHostArgumentContract.js';
import {
    ConnectorHostArgumentValidation,
    type ConnectorHostArgumentCheck,
} from 'nerva-connector-protocol/protocol/ConnectorHostArgumentValidation.js';
import { HostOperationError } from './HostOperationError.js';
import type { HostEnvironmentRequest } from './HostEnvironmentTypes.js';

/**
 * Environment inspection requests are validated completely before authorization or filesystem access.
 *
 * @remarks
 * The name rules are the `environment_inspect` argument contract in nerva-connector-protocol: unique, well-formed
 * names of 1 to 255 code points; program names are bare file names that are never `.` or `..` and contain no NUL,
 * `/` or `\`; variable names contain no NUL or `=`. Typed callers are held to the same contract as tool input.
 */
export class HostEnvironmentValidation {
    /** Accept decoded tool input or typed callers alike; any rejection is a definitive invalid request. */
    public static request(programs: unknown, variables: unknown): HostEnvironmentRequest {
        const check: ConnectorHostArgumentCheck = ConnectorHostArgumentValidation.check(
            ConnectorHostTool.EnvironmentInspect,
            { programs, variables },
            ConnectorHostArgumentContracts.paired,
        );
        if (!check.valid) {
            throw new HostOperationError(
                ConnectorHostErrorCode.InvalidRequest,
                check.message,
                true,
            );
        }
        return Object.freeze({
            programs: Object.freeze(check.arguments.list('programs')),
            variables: Object.freeze(check.arguments.list('variables')),
        });
    }
}
