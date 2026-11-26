// SPDX-FileCopyrightText: 2026 Dacely <business@dacely.com>
// SPDX-License-Identifier: LicenseRef-Proprietary

import type { ConnectorScreenFrame } from '../src/cli/ConnectorScreenPainter.js';
import { expect, it } from 'vitest';
import { ConnectorPromptEditor } from '../src/cli/ConnectorPromptEditor.js';
import { ConnectorPromptScreen } from '../src/cli/ConnectorPromptScreen.js';
import { ConnectorCodeBanner } from '../src/cli/ConnectorCodeBanner.js';
import { ConnectorTheme } from '../src/cli/ConnectorTheme.js';
import { ConnectorLogo } from '../src/cli/ConnectorLogo.js';
import {
    ConnectorPromptAction,
    ConnectorPromptKind,
    ConnectorPromptTone,
    type ConnectorPromptText,
    type ConnectorPromptSelect,
    type ConnectorPromptPanel,
} from '../src/cli/ConnectorPromptTypes.js';

const text: ConnectorPromptText = {
    kind: ConnectorPromptKind.Text,
    id: 'fixture-text',
    label: 'Computer name',
    initialValue: 'A😀B',
    hint: 'Enter confirms',
    maximumLength: 8,
};
const select: ConnectorPromptSelect = {
    kind: ConnectorPromptKind.Select,
    id: 'fixture-access',
    label: 'Access level',
    initialValue: 'write',
    hint: 'Choose explicitly',
    choices: [
        { value: 'pair', label: 'Pairing only', description: 'No host grant' },
        { value: 'read', label: 'Read files', description: 'Separate approval' },
        { value: 'write', label: 'Read and write', description: 'Separate approval' },
    ],
};

it('structured text edits preserve Unicode boundaries and submit the actual prefilled or explicitly cleared value', (): void => {
    const editor: ConnectorPromptEditor = new ConnectorPromptEditor(text);
    expect(editor.cursor).toBe(3);
    expect(editor.press(undefined, { name: 'left' })).toBeNull();
    expect(editor.press(undefined, { name: 'backspace' })).toBeNull();
    expect(editor.value).toBe('AB');
    expect(editor.cursor).toBe(1);
    editor.press(undefined, { name: 'home' });
    editor.press('Z', { name: 'z' });
    expect(editor.value).toBe('ZAB');
    editor.press(undefined, { name: 'end' });
    editor.press(undefined, { name: 'delete' });
    expect(editor.value).toBe('ZAB');
    expect(editor.press(undefined, { name: 'return' })).toEqual({
        action: ConnectorPromptAction.Submit,
        value: 'ZAB',
    });
    editor.press(undefined, { name: 'u', ctrl: true });
    expect(editor.value).toBe('');
    expect(editor.press(undefined, { name: 'return' })).toEqual({
        action: ConnectorPromptAction.Submit,
        value: '',
    });
});

it('selection arrows, boundaries and numeric shortcuts submit finite values while Escape and interruption remain distinct', (): void => {
    const editor: ConnectorPromptEditor = new ConnectorPromptEditor(select);
    expect(editor.selected).toBe(2);
    editor.press(undefined, { name: 'home' });
    expect(editor.selected).toBe(0);
    editor.press(undefined, { name: 'down' });
    expect(editor.selected).toBe(1);
    editor.press(undefined, { name: 'end' });
    expect(editor.selected).toBe(2);
    editor.press('1', { name: '1' });
    expect(editor.selected).toBe(0);
    expect(editor.press(undefined, { name: 'return' })).toEqual({
        action: ConnectorPromptAction.Submit,
        value: 'pair',
    });
    expect(editor.press(undefined, { name: 'escape' })).toEqual({
        action: ConnectorPromptAction.Back,
    });
    expect(editor.press(undefined, { name: 'c', ctrl: true })).toEqual({
        action: ConnectorPromptAction.Cancel,
    });
    expect(editor.press(undefined, { name: 'd', ctrl: true })).toEqual({
        action: ConnectorPromptAction.Cancel,
    });
});

it('a finite input bound refuses oversized edits without silently truncating a reviewed value', (): void => {
    const editor: ConnectorPromptEditor = new ConnectorPromptEditor({
        ...text,
        initialValue: 'keep',
        maximumLength: 4,
    });
    editor.press('extra', { name: 'e' });
    expect(editor.value).toBe('keep');
    expect((editor.notice ?? '').length).toBeGreaterThan(0);
    expect(editor.press(undefined, { name: 'return' })).toEqual({
        action: ConnectorPromptAction.Submit,
        value: 'keep',
    });
});

it('the themed screen keeps bounded cursor positions after resize and cannot execute controls from reviewed values', (): void => {
    const panel: ConnectorPromptPanel = {
        title: 'Setup',
        description: ['Local review'],
        details: [{ label: 'Folder', value: 'safe\x1b[999;999Hpath' }],
        step: { current: 2, total: 5 },
    };
    const editor: ConnectorPromptEditor = new ConnectorPromptEditor({
        ...text,
        initialValue: 'a'.repeat(70),
        maximumLength: 100,
    });
    for (const rows of [1, 2, 12]) {
        for (const columns of [24, 52, 100]) {
            const frame: ConnectorScreenFrame = ConnectorPromptScreen.render(
                panel,
                editor,
                columns,
                rows,
            );
            expect(frame.rows.join('\n')).toContain(String.fromCharCode(27) + '[38;2;');
            expect(frame.rows.join('\n')).not.toContain('\x1b[999;999H');
            expect(frame.cursorRow).toBeGreaterThanOrEqual(1);
            expect(frame.cursorRow).toBeLessThanOrEqual(rows);
            expect(frame.cursorColumn).toBeGreaterThanOrEqual(1);
            expect(frame.cursorColumn).toBeLessThanOrEqual(columns);
            expect(frame.cursorVisible).toBe(true);
        }
    }
});

it('Enter confirms a confirmation screen while a waiting screen ignores Enter; Escape and interruption stay distinct', (): void => {
    const confirm: ConnectorPromptEditor = new ConnectorPromptEditor({
        kind: ConnectorPromptKind.Confirm,
        id: 'fixture-confirm',
        label: 'Save and link',
        hint: 'Enter confirm',
    });
    expect(confirm.press('x', { name: 'x' })).toBeNull();
    expect(confirm.press(undefined, { name: 'return' })).toEqual({
        action: ConnectorPromptAction.Submit,
        value: '',
    });
    expect(confirm.press(undefined, { name: 'escape' })).toEqual({
        action: ConnectorPromptAction.Back,
    });
    const wait: ConnectorPromptEditor = new ConnectorPromptEditor({
        kind: ConnectorPromptKind.Wait,
        id: 'fixture-wait',
        label: 'Linking',
        hint: 'Esc later',
    });
    expect(wait.press(undefined, { name: 'return' })).toBeNull();
    expect(wait.press('y', { name: 'y' })).toBeNull();
    expect(wait.press(undefined, { name: 'escape' })).toEqual({
        action: ConnectorPromptAction.Back,
    });
    expect(wait.press(undefined, { name: 'c', ctrl: true })).toEqual({
        action: ConnectorPromptAction.Cancel,
    });
});

it('setup screens use the shared Nerva theme: orange brand and focus on near-black, never the former blue', (): void => {
    const frame: ConnectorScreenFrame = ConnectorPromptScreen.render(
        {
            title: 'Name this computer',
            description: ['Shown in your account.'],
            step: { current: 1, total: 6 },
        },
        new ConnectorPromptEditor(select),
        100,
        30,
    );
    expect(frame.rows.join('\n')).toContain(ConnectorTheme.background);
    expect(frame.rows.join('\n')).toContain(ConnectorLogo.rows()[0] ?? 'logo');
    expect(frame.rows.join('\n')).toContain('Nerva Connector');
    expect(frame.rows.join('\n')).toMatch(/› \d\. Read and write/u);
    expect(frame.rows.join('\n')).toContain(ConnectorTheme.selected);
    expect(frame.rows.join('\n')).toContain('Step 1 of 6');
    expect(frame.rows.join('\n')).not.toContain('56;189;248');
    expect(frame.rows.join('\n')).not.toContain('NEXA');
});

it('the pairing code renders in large type when there is room, and falls back to a spaced line in small terminals', (): void => {
    const panel: ConnectorPromptPanel = {
        title: 'Link to your Nerva account',
        description: ['Open this page, sign in, and enter the code below.'],
        link: 'https://nervalabs.com/chat/connectors',
        code: 'BY3Y-58N8',
        caption: 'Code BY3Y-58N8 · expires in 9:41',
        status: {
            text: 'Waiting for you to approve',
            tone: ConnectorPromptTone.Neutral,
            busy: true,
        },
        hint: 'Esc link later · Ctrl+C quit',
    };
    const banner: readonly string[] | null = ConnectorCodeBanner.render('BY3Y-58N8', 80);
    expect(banner).toHaveLength(ConnectorCodeBanner.rows);
    expect(ConnectorCodeBanner.render('BY3Y-58N8', 20)).toBeNull();
    expect(ConnectorCodeBanner.render('OI01', 80)).toBeNull();
    const large: ConnectorScreenFrame = ConnectorPromptScreen.render(panel, null, 80, 24, 1);
    for (const row of banner ?? []) {
        expect(large.rows.join('\n')).toContain(row);
    }
    expect(large.rows.join('\n')).toContain('https://nervalabs.com/chat/connectors');
    expect(large.rows.join('\n')).toContain(
        ConnectorPromptScreen.spinner[1] + '  Waiting for you to approve',
    );
    expect(large.rows.join('\n')).toContain('Esc link later · Ctrl+C quit');
    const narrow: ConnectorScreenFrame = ConnectorPromptScreen.render(panel, null, 40, 24);
    expect(narrow.rows.join('\n')).toContain('B Y 3 Y - 5 8 N 8');
    for (const [columns, rows] of [
        [40, 24],
        [40, 7],
        [80, 9],
        [80, 6],
    ] as const) {
        const small: ConnectorScreenFrame = ConnectorPromptScreen.render(
            panel,
            null,
            columns,
            rows,
        );
        expect(
            small.rows.join('\n').includes('B Y 3 Y - 5 8 N 8') ||
                (banner ?? []).every((row: string): boolean => small.rows.join('\n').includes(row)),
        ).toBe(true);
        expect(small.rows.join('\n')).toContain('Link to your Nerva account');
        expect(small.rows.join('\n')).toContain('Esc link later');
        expect(small.rows.join('\n').split('\n').length).toBeLessThanOrEqual(rows);
    }
    expect(ConnectorPromptScreen.render(panel, null, 80, 3).rows.join('\n')).toContain('BY3Y-58N8');
});
