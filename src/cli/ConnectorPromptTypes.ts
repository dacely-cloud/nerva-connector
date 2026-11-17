// SPDX-FileCopyrightText: 2026 Nerva contributors
// SPDX-License-Identifier: LicenseRef-Proprietary

/** Explicit navigation never substitutes missing terminal input for approval. */
export const ConnectorPromptAction = { Submit: 'submit', Back: 'back', Cancel: 'cancel' } as const;
/** Submitted field content remains distinct from both navigation outcomes. */
export interface ConnectorPromptSubmit {
    readonly action: typeof ConnectorPromptAction.Submit;
    readonly value: string;
}
/** Back returns to the previous step without granting authority. */
export interface ConnectorPromptBack {
    readonly action: typeof ConnectorPromptAction.Back;
}
/** Cancellation ends the current screen without approving new effects. */
export interface ConnectorPromptCancel {
    readonly action: typeof ConnectorPromptAction.Cancel;
}
/** The current prompt contract has no string-based navigation or legacy line driver. */
export type ConnectorPromptResult =
    ConnectorPromptSubmit | ConnectorPromptBack | ConnectorPromptCancel;

/** Semantic colors are selected by the screen, never supplied as terminal escape sequences. */
export const ConnectorPromptTone = {
    Neutral: 'neutral',
    Warning: 'warning',
    Success: 'success',
    Error: 'error',
} as const;
/** Tone values derive from their runtime mapping. */
export type ConnectorPromptTone = (typeof ConnectorPromptTone)[keyof typeof ConnectorPromptTone];

/** Each focused control has exactly one declared kind. */
export const ConnectorPromptKind = {
    Text: 'text',
    Select: 'select',
    Confirm: 'confirm',
    Wait: 'wait',
} as const;
/** Control kinds derive from their runtime mapping. */
export type ConnectorPromptKind = (typeof ConnectorPromptKind)[keyof typeof ConnectorPromptKind];

/** The only answers that change access; anything else keeps the current state. */
export const ConnectorApproval = {
    NotNow: 'not-now',
    Allow: 'allow',
    Keep: 'keep',
    TurnOff: 'turn-off',
} as const;
/** Approval answers derive from their runtime mapping. */
export type ConnectorApproval = (typeof ConnectorApproval)[keyof typeof ConnectorApproval];

/** A concise reviewed fact appears under a labeled panel row. */
export interface ConnectorPromptDetail {
    readonly label: string;
    readonly value: string;
}
/** Progress is explicit metadata rather than extracted from human copy. */
export interface ConnectorPromptStep {
    readonly current: number;
    readonly total: number;
}
/** One plain status line; busy lines carry the calm animated indicator. */
export interface ConnectorPromptStatus {
    readonly text: string;
    readonly tone: ConnectorPromptTone;
    readonly busy: boolean;
}
/** One complete panel replaces the previous screen and sanitizes every displayed value. */
export interface ConnectorPromptPanel {
    /** What this screen belongs to, shown beside the logo; defaults to "Setup". */
    readonly context?: string;
    readonly title: string;
    readonly description: readonly string[];
    readonly details?: readonly ConnectorPromptDetail[];
    readonly step?: ConnectorPromptStep;
    readonly tone?: ConnectorPromptTone;
    /** A trusted HTTPS page shown prominently in the accent color. */
    readonly link?: string;
    /** A short pairing code rendered in large type when the terminal has room. */
    readonly code?: string;
    /** A plain line under the code, such as its remaining lifetime. */
    readonly caption?: string;
    readonly status?: ConnectorPromptStatus;
    /** The key-hint line shown when no editable control is focused. */
    readonly hint?: string;
}
/** Text fields contain their actual editable default. */
export interface ConnectorPromptText {
    readonly kind: typeof ConnectorPromptKind.Text;
    readonly id: string;
    /** Short field name, used where the terminal is too small for the panel title. */
    readonly label: string;
    readonly initialValue: string;
    /** The single key-hint line shown while this control is focused. */
    readonly hint: string;
    readonly maximumLength: number;
}
/** A selectable value and its consequence share one typed option. */
export interface ConnectorPromptChoice {
    readonly value: string;
    readonly label: string;
    readonly description: string;
    /** Choices with serious consequences show their description in the warning color. */
    readonly caution?: boolean;
    /** A short tag shown at the right of the choice, such as "Most useful". */
    readonly badge?: string;
}
/** Arrow selection commits the exact runtime value of one option. */
export interface ConnectorPromptSelect {
    readonly kind: typeof ConnectorPromptKind.Select;
    readonly id: string;
    readonly label: string;
    readonly choices: readonly ConnectorPromptChoice[];
    readonly initialValue: string;
    readonly hint: string;
}
/** Enter performs the one named action on the current screen; Esc goes back. */
export interface ConnectorPromptConfirm {
    readonly kind: typeof ConnectorPromptKind.Confirm;
    readonly id: string;
    /** The action Enter performs, shown as the focused button. */
    readonly label: string;
    readonly hint: string;
}
/** A passive control while work runs: Enter does nothing, Esc and Ctrl+C stay available. */
export interface ConnectorPromptWait {
    readonly kind: typeof ConnectorPromptKind.Wait;
    readonly id: string;
    readonly label: string;
    readonly hint: string;
}
/** Every focusable control in the current prompt contract. */
export type ConnectorPromptQuestion =
    ConnectorPromptText | ConnectorPromptSelect | ConnectorPromptConfirm | ConnectorPromptWait;
