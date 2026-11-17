// SPDX-FileCopyrightText: 2026 Nerva contributors
// SPDX-License-Identifier: LicenseRef-Proprietary

import { ExecutionMachineRuleCodec } from './ExecutionMachineRuleCodec.js';
import { ExecutionInteractiveRuleCodec } from './ExecutionInteractiveRuleCodec.js';
import {
    type ExecutionProgramPolicy,
    type ExecutionRootPolicy,
    type ExecutionArgumentRule,
    type ExecutionPolicyDefinition,
} from './ExecutionPolicyTypes.js';
import { ExecutionArgumentKind } from 'nerva-connector-protocol/execution/ExecutionArgumentKind.js';
import type {
    ExecutionProfile,
    ExecutionRootGrant,
    ExecutionProgramGrant,
    ExecutionInputRule,
} from './ExecutionJobs.js';

/** Projection borrows validated metadata only, without requiring ownership of executable or filesystem handles. */
export interface ExecutionPublicProfileSource {
    readonly definition: ExecutionPolicyDefinition;
    readonly policySha256: string;
}

/** One detached immutable public projection excludes private executables, positional fixed arguments and local paths while preserving every granted input and resource ceiling. */
export function executionPublicProfile(policy: ExecutionPublicProfileSource): ExecutionProfile {
    return Object.freeze({
        revision: policy.definition.revision,
        policySha256: policy.policySha256,
        roots: Object.freeze(
            policy.definition.roots.map((root: ExecutionRootPolicy): ExecutionRootGrant =>
                Object.freeze({ id: root.id, access: root.access }),
            ),
        ),
        programs: Object.freeze(
            policy.definition.programs.map(
                (program: ExecutionProgramPolicy): ExecutionProgramGrant =>
                    Object.freeze({
                        id: program.id,
                        rootIds: Object.freeze([...program.rootIds]),
                        arguments: Object.freeze(
                            program.arguments.flatMap(
                                (rule: ExecutionArgumentRule): readonly ExecutionInputRule[] =>
                                    rule.kind === ExecutionArgumentKind.Literal
                                        ? []
                                        : [
                                              Object.freeze(
                                                  rule.kind ===
                                                      ExecutionArgumentKind.MachineInvocation
                                                      ? ExecutionMachineRuleCodec.read(rule)
                                                      : rule.kind ===
                                                          ExecutionArgumentKind.InteractiveInvocation
                                                        ? ExecutionInteractiveRuleCodec.body(rule)
                                                        : rule.kind === ExecutionArgumentKind.Choice
                                                          ? {
                                                                kind: rule.kind,
                                                                values: Object.freeze([
                                                                    ...rule.values,
                                                                ]),
                                                            }
                                                          : { ...rule },
                                              ),
                                          ],
                            ),
                        ),
                    }),
            ),
        ),
        resources: Object.freeze({ ...policy.definition.resources }),
        timeoutMs: policy.definition.timeoutMs,
        maximumAddressBytes: policy.definition.maximumAddressBytes,
        maximumFileBytes: policy.definition.maximumFileBytes,
    });
}
