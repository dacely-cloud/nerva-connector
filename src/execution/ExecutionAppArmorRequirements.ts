// SPDX-FileCopyrightText: 2026 Nerva contributors
// SPDX-License-Identifier: LicenseRef-Proprietary

import { ExecutionAppArmorMode } from './ExecutionAppArmorProfile.js';
import { ExecutionPipePolicy } from './ExecutionPipePolicy.js';
import type { ExecutionPolicyDefinition } from './ExecutionPolicyTypes.js';

/** Every locally published execution mode requires its own exact enforcing launcher and payload stack. */
export class ExecutionAppArmorRequirements {
    /** Mode selection follows validated argument authority rather than executable names or remote launch data. */
    public static modes(definition: ExecutionPolicyDefinition): readonly ExecutionAppArmorMode[] {
        const modes: Set<ExecutionAppArmorMode> = new Set();
        for (const program of definition.programs) {
            modes.add(
                ExecutionPipePolicy.program(program, definition.timeoutMs) === null
                    ? ExecutionAppArmorMode.Foreground
                    : ExecutionAppArmorMode.Pipe,
            );
        }
        if (modes.size === 0) {
            throw new Error('Explicit local execution programs required');
        }
        return Object.freeze([...modes]);
    }
}
