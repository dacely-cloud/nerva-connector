// SPDX-FileCopyrightText: 2026 Nerva contributors
// SPDX-License-Identifier: LicenseRef-Proprietary

import type { Key } from 'node:readline';
import {
    ConnectorPromptAction,
    ConnectorPromptKind,
    type ConnectorPromptChoice,
    type ConnectorPromptQuestion,
    type ConnectorPromptResult,
} from './ConnectorPromptTypes.js';

/** A bounded editable field, choice, confirmation or wait owns keyboard state independently from terminal I/O. */
export class ConnectorPromptEditor {
    #value: string;
    #cursor: number;
    #selected: number = 0;
    #notice: string | null = null;
    /** Initial values are real field contents and must fit the current declared question. */
    public constructor(public readonly question: ConnectorPromptQuestion) {
        if (question.kind === ConnectorPromptKind.Select) {
            this.#value = '';
            this.#cursor = 0;
            if (
                question.choices.length < 1 ||
                question.choices.length > 8 ||
                new Set(
                    question.choices.map((choice: ConnectorPromptChoice): string => choice.value),
                ).size !== question.choices.length
            ) {
                throw new Error('Invalid connector selection');
            }
            this.#selected = question.choices.findIndex(
                (choice: ConnectorPromptChoice): boolean => choice.value === question.initialValue,
            );
            if (this.#selected < 0) {
                throw new Error('Connector selection requires a valid initial value');
            }
        } else if (question.kind === ConnectorPromptKind.Text) {
            this.#value = question.initialValue;
            this.#cursor = Array.from(this.#value).length;
            if (
                !Number.isSafeInteger(question.maximumLength) ||
                question.maximumLength < 1 ||
                question.maximumLength > 32768 ||
                this.#value.length > question.maximumLength ||
                !this.#value.isWellFormed()
            ) {
                throw new Error('Invalid connector text field');
            }
        } else {
            this.#value = '';
            this.#cursor = 0;
        }
    }
    /** Exact text remains separate from its sanitized display representation. */
    public get value(): string {
        return this.#value;
    }
    /** Code-point positions never split a UTF-16 surrogate pair during editing. */
    public get cursor(): number {
        return this.#cursor;
    }
    /** The focused choice is always a valid index in the declared finite options. */
    public get selected(): number {
        return this.#selected;
    }
    /** Input limits produce a visible field notice without discarding the user's current content. */
    public get notice(): string | null {
        return this.#notice;
    }

    /** Native key events produce typed navigation; ordinary text is never interpreted as a command. */
    public press(text: string | undefined, key: Key): ConnectorPromptResult | null {
        if (key.ctrl && (key.name === 'c' || key.name === 'd')) {
            return { action: ConnectorPromptAction.Cancel };
        }
        if (key.name === 'escape') {
            return { action: ConnectorPromptAction.Back };
        }
        const question: ConnectorPromptQuestion = this.question;
        if (question.kind === ConnectorPromptKind.Wait) {
            return null;
        }
        if (key.name === 'return') {
            return {
                action: ConnectorPromptAction.Submit,
                value:
                    question.kind === ConnectorPromptKind.Select
                        ? (question.choices[this.#selected]?.value ?? '')
                        : this.#value,
            };
        }
        this.#notice = null;
        if (question.kind === ConnectorPromptKind.Select) {
            const count: number = question.choices.length;
            if (key.name === 'up' || key.name === 'left') {
                this.#selected = (this.#selected + count - 1) % count;
            } else if (key.name === 'down' || key.name === 'right' || key.name === 'tab') {
                this.#selected = (this.#selected + 1) % count;
            } else if (key.name === 'home') {
                this.#selected = 0;
            } else if (key.name === 'end') {
                this.#selected = count - 1;
            } else if (text !== undefined && /^[1-8]$/u.test(text) && Number(text) <= count) {
                this.#selected = Number(text) - 1;
            }
            return null;
        }
        if (question.kind === ConnectorPromptKind.Confirm) {
            return null;
        }
        const characters: string[] = Array.from(this.#value);
        if (key.name === 'left') {
            this.#cursor = Math.max(0, this.#cursor - 1);
        } else if (key.name === 'right') {
            this.#cursor = Math.min(characters.length, this.#cursor + 1);
        } else if (key.name === 'home' || (key.ctrl && key.name === 'a')) {
            this.#cursor = 0;
        } else if (key.name === 'end' || (key.ctrl && key.name === 'e')) {
            this.#cursor = characters.length;
        } else if (key.ctrl && key.name === 'u') {
            this.#value = '';
            this.#cursor = 0;
        } else if (key.name === 'backspace' && this.#cursor > 0) {
            characters.splice(--this.#cursor, 1);
            this.#value = characters.join('');
        } else if (key.name === 'delete') {
            characters.splice(this.#cursor, 1);
            this.#value = characters.join('');
        } else if (
            text !== undefined &&
            !key.ctrl &&
            !key.meta &&
            text.isWellFormed() &&
            !/[\p{Cc}\p{Cf}]/u.test(text)
        ) {
            if (this.#value.length + text.length > question.maximumLength) {
                this.#notice = 'This field is full.';
            } else {
                const added: string[] = Array.from(text);
                characters.splice(this.#cursor, 0, ...added);
                this.#cursor += added.length;
                this.#value = characters.join('');
            }
        }
        return null;
    }
}
