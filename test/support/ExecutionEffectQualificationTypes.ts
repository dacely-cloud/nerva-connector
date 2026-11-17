// SPDX-FileCopyrightText: 2026 Nerva contributors
// SPDX-License-Identifier: LicenseRef-Proprietary

import type { ExecutionFreshTrace } from './ExecutionEffectTrace.js';

/** Every reported result is a fixed public label, never private provenance or an executable path. */
export enum ExecutionEffectCase {
    Input = 'input',
    Fresh = 'durable-capture-before-effect',
    Recovery = 'real-command-prefix-recovery',
    Cleanup = 'matching-live-canary-physical-cleanup',
    Pinned = 'pinned-renamed-workspace',
    Terminal = 'terminal-no-foreign-cleanup',
    Reincarnated = 'reincarnated-group-refusal',
    Boot = 'simulated-stale-boot-refusal',
    Uncommitted = 'uncommitted-group-refusal',
    Parent = 'replaced-parent-refusal',
}

/** Only these already granted static fixture payloads can enter the native command path. */
export enum ExecutionEffectPayload {
    Effect = 'effect',
    OutputHold = 'output-hold',
}

/** The controller owns and verifies these exact supplied artifacts and the empty delegated subtree. */
export interface ExecutionEffectSettings {
    readonly directory: string;
    readonly runtimeParent: string;
    readonly helper: string;
    readonly probe: string;
    readonly delegation: string;
}

/** Files remain for controller cleanup only after the complete process and kernel resource audit. */
export interface ExecutionEffectCleanup {
    readonly keysReleased: boolean;
    readonly kernelQuiescent: boolean;
    readonly profilesRemoved: boolean;
    readonly descriptorsReleased: boolean;
}

/** The entire bounded output omits identities, keys, command data, paths and underlying errors. */
export interface ExecutionEffectReport extends ExecutionEffectCleanup {
    readonly trace: ExecutionFreshTrace | null;
    readonly passed: boolean;
    readonly cases: readonly ExecutionEffectCase[];
    readonly failed: ExecutionEffectCase | null;
    readonly sourcesRetained: true;
}

/** Assertion failures cannot format private values into diagnostics. */
export function requireEffect(value: boolean): void {
    if (!value) {
        throw new Error('Execution qualification assertion failed');
    }
}
