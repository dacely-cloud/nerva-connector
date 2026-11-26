// SPDX-FileCopyrightText: 2026 Dacely <business@dacely.com>
// SPDX-License-Identifier: LicenseRef-Proprietary

import { ConnectorHostTool } from 'nerva-connector-protocol/protocol/ConnectorHost.js';
import { HostDesktopKeyAction, HostDesktopPointerAction } from '../host/HostDesktopTypes.js';
import { HostWriteMode } from '../host/HostWorkspaceTypes.js';
import { ConnectorActivityKind } from './ConnectorActivity.js';
import { ConnectorActivityArguments } from './ConnectorActivityArguments.js';
import { ConnectorActivityLaneOperation } from './ConnectorActivityLane.js';

/** Plain words for one request: the kind of effect, a short sentence and what it acts on. */
export interface ConnectorActivityDescribed {
    /** The group a person scans for. */
    readonly kind: ConnectorActivityKind;
    /** A short plain sentence such as "Reading a file". */
    readonly title: string;
    /** A path, command line, web address or count; sanitized and at most 2000 characters, or empty. */
    readonly subject: string;
}

/** Turns one request's arguments into plain words. */
type ConnectorActivityRule = (args: ConnectorActivityArguments) => ConnectorActivityDescribed;

/**
 * Describes every host tool and local lane operation in words a ten-year-old understands.
 *
 * @remarks
 * Subjects name only what a request acts on: paths, command lines, a web address's host and path, a hostname or
 * program names. File contents, written data, typed text, program input, environment values, HTTP headers and
 * URL query strings or user information are never read into a subject. Unknown tools get a generic entry.
 */
export class ConnectorActivityDescription {
    /** Longest subject in characters, including a closing ellipsis. */
    public static readonly subjectLimit: number = 2000;
    /** Raw characters examined before sanitizing, which bounds the work for any argument size. */
    static readonly #scanLimit: number = 8192;
    /** Most array items, such as program arguments or names, read into a subject. */
    static readonly #items: number = 256;
    static readonly #host: Readonly<Record<ConnectorHostTool, ConnectorActivityRule>> = {
        [ConnectorHostTool.ApplicationOpen]: (
            args: ConnectorActivityArguments,
        ): ConnectorActivityDescribed =>
            ConnectorActivityDescription.#entry(
                ConnectorActivityKind.RunCommand,
                'Opening an application',
                args.text('name'),
            ),
        [ConnectorHostTool.DesktopSnapshot]: (): ConnectorActivityDescribed =>
            ConnectorActivityDescription.#entry(
                ConnectorActivityKind.Screen,
                'Looking at the screen',
                '',
            ),
        [ConnectorHostTool.FileRead]: (
            args: ConnectorActivityArguments,
        ): ConnectorActivityDescribed =>
            ConnectorActivityDescription.#entry(
                ConnectorActivityKind.ReadFile,
                'Reading a file',
                args.text('path'),
            ),
        [ConnectorHostTool.FileDigest]: (
            args: ConnectorActivityArguments,
        ): ConnectorActivityDescribed =>
            ConnectorActivityDescription.#entry(
                ConnectorActivityKind.ReadFile,
                'Checking a file',
                args.text('path'),
            ),
        [ConnectorHostTool.FileStat]: (
            args: ConnectorActivityArguments,
        ): ConnectorActivityDescribed =>
            ConnectorActivityDescription.#entry(
                ConnectorActivityKind.ReadFile,
                "Looking at a file's details",
                args.text('path'),
            ),
        [ConnectorHostTool.DirectoryList]: (
            args: ConnectorActivityArguments,
        ): ConnectorActivityDescribed =>
            ConnectorActivityDescription.#entry(
                ConnectorActivityKind.ReadFile,
                'Listing a folder',
                args.text('path'),
            ),
        [ConnectorHostTool.FileWrite]: (
            args: ConnectorActivityArguments,
        ): ConnectorActivityDescribed =>
            ConnectorActivityDescription.#entry(
                ConnectorActivityKind.ChangeFile,
                ConnectorActivityDescription.#writeTitle(args.text('mode')),
                args.text('path'),
            ),
        [ConnectorHostTool.FilePublish]: (
            args: ConnectorActivityArguments,
        ): ConnectorActivityDescribed =>
            ConnectorActivityDescription.#entry(
                ConnectorActivityKind.ChangeFile,
                'Saving a file',
                args.text('destination'),
            ),
        [ConnectorHostTool.FileRename]: (
            args: ConnectorActivityArguments,
        ): ConnectorActivityDescribed =>
            ConnectorActivityDescription.#entry(
                ConnectorActivityKind.ChangeFile,
                'Renaming a file',
                ConnectorActivityDescription.#move(args.text('source'), args.text('destination')),
            ),
        [ConnectorHostTool.FileChmod]: (
            args: ConnectorActivityArguments,
        ): ConnectorActivityDescribed =>
            ConnectorActivityDescription.#entry(
                ConnectorActivityKind.ChangeFile,
                'Changing who can use a file',
                args.text('path'),
            ),
        [ConnectorHostTool.DirectoryCreate]: (
            args: ConnectorActivityArguments,
        ): ConnectorActivityDescribed =>
            ConnectorActivityDescription.#entry(
                ConnectorActivityKind.ChangeFile,
                'Making a folder',
                args.text('path'),
            ),
        [ConnectorHostTool.FileRemove]: (
            args: ConnectorActivityArguments,
        ): ConnectorActivityDescribed =>
            ConnectorActivityDescription.#entry(
                ConnectorActivityKind.ChangeFile,
                ConnectorActivityDescription.#removeTitle(args.flag('recursive')),
                args.text('path'),
            ),
        [ConnectorHostTool.ProcessStart]: (
            args: ConnectorActivityArguments,
        ): ConnectorActivityDescribed =>
            ConnectorActivityDescription.#entry(
                ConnectorActivityKind.RunCommand,
                'Starting a program',
                ConnectorActivityDescription.#commandLine(args),
            ),
        [ConnectorHostTool.ProcessRead]: (): ConnectorActivityDescribed =>
            ConnectorActivityDescription.#entry(
                ConnectorActivityKind.RunCommand,
                "Checking a program's output",
                '',
            ),
        [ConnectorHostTool.ProcessWrite]: (): ConnectorActivityDescribed =>
            ConnectorActivityDescription.#entry(
                ConnectorActivityKind.RunCommand,
                'Typing into a program',
                '',
            ),
        [ConnectorHostTool.ProcessStop]: (): ConnectorActivityDescribed =>
            ConnectorActivityDescription.#entry(
                ConnectorActivityKind.RunCommand,
                'Stopping a program',
                '',
            ),
        [ConnectorHostTool.ProcessRelease]: (): ConnectorActivityDescribed =>
            ConnectorActivityDescription.#entry(
                ConnectorActivityKind.RunCommand,
                'Closing a program',
                '',
            ),
        [ConnectorHostTool.TerminalStart]: (
            args: ConnectorActivityArguments,
        ): ConnectorActivityDescribed =>
            ConnectorActivityDescription.#entry(
                ConnectorActivityKind.Terminal,
                'Opening a terminal',
                ConnectorActivityDescription.#commandLine(args),
            ),
        [ConnectorHostTool.TerminalRead]: (): ConnectorActivityDescribed =>
            ConnectorActivityDescription.#entry(
                ConnectorActivityKind.Terminal,
                "Checking a terminal's output",
                '',
            ),
        [ConnectorHostTool.TerminalWrite]: (): ConnectorActivityDescribed =>
            ConnectorActivityDescription.#entry(
                ConnectorActivityKind.Terminal,
                'Typing into a terminal',
                '',
            ),
        [ConnectorHostTool.TerminalResize]: (): ConnectorActivityDescribed =>
            ConnectorActivityDescription.#entry(
                ConnectorActivityKind.Terminal,
                'Resizing a terminal',
                '',
            ),
        [ConnectorHostTool.TerminalStop]: (): ConnectorActivityDescribed =>
            ConnectorActivityDescription.#entry(
                ConnectorActivityKind.Terminal,
                'Stopping a terminal',
                '',
            ),
        [ConnectorHostTool.TerminalRelease]: (): ConnectorActivityDescribed =>
            ConnectorActivityDescription.#entry(
                ConnectorActivityKind.Terminal,
                'Closing a terminal',
                '',
            ),
        [ConnectorHostTool.DesktopInfo]: (): ConnectorActivityDescribed =>
            ConnectorActivityDescription.#entry(
                ConnectorActivityKind.Screen,
                'Checking the screen',
                '',
            ),
        [ConnectorHostTool.DesktopScreenshot]: (
            args: ConnectorActivityArguments,
        ): ConnectorActivityDescribed =>
            ConnectorActivityDescription.#entry(
                ConnectorActivityKind.Screen,
                'Taking a screenshot',
                args.text('path'),
            ),
        [ConnectorHostTool.DesktopPointer]: (
            args: ConnectorActivityArguments,
        ): ConnectorActivityDescribed =>
            ConnectorActivityDescription.#entry(
                ConnectorActivityKind.Control,
                ConnectorActivityDescription.#pointerTitle(args.text('action')),
                ConnectorActivityDescription.#pointer(args),
            ),
        [ConnectorHostTool.DesktopKey]: (
            args: ConnectorActivityArguments,
        ): ConnectorActivityDescribed =>
            ConnectorActivityDescription.#entry(
                ConnectorActivityKind.Control,
                ConnectorActivityDescription.#keyTitle(args.text('action')),
                ConnectorActivityDescription.#key(args.text('key')),
            ),
        [ConnectorHostTool.DesktopText]: (
            args: ConnectorActivityArguments,
        ): ConnectorActivityDescribed =>
            ConnectorActivityDescription.#entry(
                ConnectorActivityKind.Control,
                'Typing text',
                ConnectorActivityDescription.#characters(args.text('text')),
            ),
        [ConnectorHostTool.NetworkResolve]: (
            args: ConnectorActivityArguments,
        ): ConnectorActivityDescribed =>
            ConnectorActivityDescription.#entry(
                ConnectorActivityKind.Web,
                'Looking up a web address',
                args.text('hostname'),
            ),
        [ConnectorHostTool.HttpOpen]: (
            args: ConnectorActivityArguments,
        ): ConnectorActivityDescribed =>
            ConnectorActivityDescription.#entry(
                ConnectorActivityKind.Web,
                'Opening a web page',
                ConnectorActivityDescription.#address(args.text('url')),
            ),
        [ConnectorHostTool.HttpRead]: (): ConnectorActivityDescribed =>
            ConnectorActivityDescription.#entry(
                ConnectorActivityKind.Web,
                'Reading a web page',
                '',
            ),
        [ConnectorHostTool.HttpClose]: (): ConnectorActivityDescribed =>
            ConnectorActivityDescription.#entry(
                ConnectorActivityKind.Web,
                'Closing a web page',
                '',
            ),
        [ConnectorHostTool.ComputerInfo]: (): ConnectorActivityDescribed =>
            ConnectorActivityDescription.#entry(
                ConnectorActivityKind.System,
                'Reading computer details',
                '',
            ),
        [ConnectorHostTool.EnvironmentInspect]: (
            args: ConnectorActivityArguments,
        ): ConnectorActivityDescribed =>
            ConnectorActivityDescription.#entry(
                ConnectorActivityKind.System,
                'Checking installed programs',
                args.texts('programs', ConnectorActivityDescription.#items).join(', '),
            ),
    };
    static readonly #lanes: Readonly<
        Record<ConnectorActivityLaneOperation, ConnectorActivityRule>
    > = {
        [ConnectorActivityLaneOperation.FolderRead]: (
            args: ConnectorActivityArguments,
        ): ConnectorActivityDescribed =>
            ConnectorActivityDescription.#entry(
                ConnectorActivityKind.ReadFile,
                'Reading a file',
                ConnectorActivityDescription.#folderPath(args, 'path'),
            ),
        [ConnectorActivityLaneOperation.FolderStat]: (
            args: ConnectorActivityArguments,
        ): ConnectorActivityDescribed =>
            ConnectorActivityDescription.#entry(
                ConnectorActivityKind.ReadFile,
                "Looking at a file's details",
                ConnectorActivityDescription.#folderPath(args, 'path'),
            ),
        [ConnectorActivityLaneOperation.FolderList]: (
            args: ConnectorActivityArguments,
        ): ConnectorActivityDescribed =>
            ConnectorActivityDescription.#entry(
                ConnectorActivityKind.ReadFile,
                'Listing a folder',
                ConnectorActivityDescription.#folderPath(args, 'path'),
            ),
        [ConnectorActivityLaneOperation.FolderWrite]: (
            args: ConnectorActivityArguments,
        ): ConnectorActivityDescribed =>
            ConnectorActivityDescription.#entry(
                ConnectorActivityKind.ChangeFile,
                args.flag('create') ? 'Creating a file' : 'Changing a file',
                ConnectorActivityDescription.#folderPath(args, 'path'),
            ),
        [ConnectorActivityLaneOperation.FolderRemove]: (
            args: ConnectorActivityArguments,
        ): ConnectorActivityDescribed =>
            ConnectorActivityDescription.#entry(
                ConnectorActivityKind.ChangeFile,
                ConnectorActivityDescription.#removeTitle(args.flag('recursive')),
                ConnectorActivityDescription.#folderPath(args, 'path'),
            ),
        [ConnectorActivityLaneOperation.FolderCreate]: (
            args: ConnectorActivityArguments,
        ): ConnectorActivityDescribed =>
            ConnectorActivityDescription.#entry(
                ConnectorActivityKind.ChangeFile,
                'Making a folder',
                ConnectorActivityDescription.#folderPath(args, 'path'),
            ),
        [ConnectorActivityLaneOperation.FolderChmod]: (
            args: ConnectorActivityArguments,
        ): ConnectorActivityDescribed =>
            ConnectorActivityDescription.#entry(
                ConnectorActivityKind.ChangeFile,
                'Changing who can use a file',
                ConnectorActivityDescription.#folderPath(args, 'path'),
            ),
        [ConnectorActivityLaneOperation.FolderRename]: (
            args: ConnectorActivityArguments,
        ): ConnectorActivityDescribed =>
            ConnectorActivityDescription.#entry(
                ConnectorActivityKind.ChangeFile,
                'Renaming a file',
                ConnectorActivityDescription.#move(
                    ConnectorActivityDescription.#folderPath(args, 'path'),
                    ConnectorActivityDescription.#folderPath(args, 'destination'),
                ),
            ),
        [ConnectorActivityLaneOperation.UploadBegin]: (
            args: ConnectorActivityArguments,
        ): ConnectorActivityDescribed =>
            ConnectorActivityDescription.#entry(
                ConnectorActivityKind.ChangeFile,
                'Getting ready to save a file',
                ConnectorActivityDescription.#folderPath(args, 'path'),
            ),
        [ConnectorActivityLaneOperation.UploadChunk]: (
            args: ConnectorActivityArguments,
        ): ConnectorActivityDescribed =>
            ConnectorActivityDescription.#entry(
                ConnectorActivityKind.ChangeFile,
                'Saving part of a file',
                ConnectorActivityDescription.#folderPath(args, 'path'),
            ),
        [ConnectorActivityLaneOperation.UploadStatus]: (
            args: ConnectorActivityArguments,
        ): ConnectorActivityDescribed =>
            ConnectorActivityDescription.#entry(
                ConnectorActivityKind.ChangeFile,
                'Checking a file being saved',
                ConnectorActivityDescription.#folderPath(args, 'path'),
            ),
        [ConnectorActivityLaneOperation.UploadCommit]: (
            args: ConnectorActivityArguments,
        ): ConnectorActivityDescribed =>
            ConnectorActivityDescription.#entry(
                ConnectorActivityKind.ChangeFile,
                'Finishing saving a file',
                ConnectorActivityDescription.#folderPath(args, 'path'),
            ),
        [ConnectorActivityLaneOperation.UploadAbort]: (
            args: ConnectorActivityArguments,
        ): ConnectorActivityDescribed =>
            ConnectorActivityDescription.#entry(
                ConnectorActivityKind.ChangeFile,
                'Cancelling saving a file',
                ConnectorActivityDescription.#folderPath(args, 'path'),
            ),
        [ConnectorActivityLaneOperation.CommandRun]: (
            args: ConnectorActivityArguments,
        ): ConnectorActivityDescribed =>
            ConnectorActivityDescription.#entry(
                ConnectorActivityKind.RunCommand,
                'Running a program',
                ConnectorActivityDescription.#program(args),
            ),
        [ConnectorActivityLaneOperation.CommandStop]: (
            args: ConnectorActivityArguments,
        ): ConnectorActivityDescribed =>
            ConnectorActivityDescription.#entry(
                ConnectorActivityKind.RunCommand,
                'Stopping a program',
                ConnectorActivityDescription.#program(args),
            ),
    };
    static readonly #rules: ReadonlyMap<string, ConnectorActivityRule> = new Map<
        string,
        ConnectorActivityRule
    >([
        ...Object.entries(ConnectorActivityDescription.#host),
        ...Object.entries(ConnectorActivityDescription.#lanes),
    ]);
    static readonly #unknown: ConnectorActivityDescribed = Object.freeze({
        kind: ConnectorActivityKind.System,
        title: 'Working on this computer',
        subject: '',
    });

    /**
     * Describes one request.
     *
     * @param toolName - A host tool name or a {@link ConnectorActivityLaneOperation}; anything else is generic
     * @param args - The request's arguments, read defensively
     */
    public static describe(
        toolName: string,
        args: ConnectorActivityArguments,
    ): ConnectorActivityDescribed {
        const rule: ConnectorActivityRule | undefined =
            ConnectorActivityDescription.#rules.get(toolName);
        return rule === undefined ? ConnectorActivityDescription.#unknown : rule(args);
    }

    /**
     * Makes text safe to print on one line.
     *
     * @returns The text without control or format characters, with every run of whitespace as one space, trimmed
     * and cut to {@link ConnectorActivityDescription.subjectLimit} characters ending in "…" when it was longer
     */
    public static sanitize(raw: string): string {
        const scanned: string =
            raw.length > ConnectorActivityDescription.#scanLimit
                ? raw.slice(0, ConnectorActivityDescription.#scanLimit)
                : raw;
        const clean: string = scanned
            .toWellFormed()
            .replace(/[\s\p{Cc}\p{Cf}]+/gu, (run: string): string => (/\s/u.test(run) ? ' ' : ''))
            .trim();
        if (
            clean.length <= ConnectorActivityDescription.subjectLimit &&
            scanned.length === raw.length
        ) {
            return clean;
        }
        let end: number = Math.min(clean.length, ConnectorActivityDescription.subjectLimit - 1);
        const last: number = clean.charCodeAt(end - 1);
        if (end > 0 && last >= 0xd800 && last <= 0xdbff) {
            end -= 1;
        }
        return clean.slice(0, end).trimEnd() + '…';
    }

    static #entry(
        kind: ConnectorActivityKind,
        title: string,
        subject: string,
    ): ConnectorActivityDescribed {
        return { kind, title, subject: ConnectorActivityDescription.sanitize(subject) };
    }

    static #writeTitle(mode: string): string {
        if (mode === HostWriteMode.Create) {
            return 'Creating a file';
        }
        return mode === HostWriteMode.Append ? 'Adding to a file' : 'Changing a file';
    }

    static #removeTitle(recursive: boolean): string {
        return recursive ? 'Deleting a folder' : 'Deleting a file';
    }

    static #move(source: string, destination: string): string {
        if (source === '' || destination === '') {
            return source + destination;
        }
        return `${source} → ${destination}`;
    }

    /** A shell command as written, or the executable followed by its arguments; environment values are not read. */
    static #commandLine(args: ConnectorActivityArguments): string {
        const command: string = args.text('command');
        if (command !== '') {
            return command;
        }
        return [
            args.text('executable'),
            ...args.texts('arguments', ConnectorActivityDescription.#items),
        ]
            .filter((part: string): boolean => part !== '')
            .join(' ');
    }

    static #program(args: ConnectorActivityArguments): string {
        return [
            args.text('programId'),
            ...args.texts('arguments', ConnectorActivityDescription.#items),
        ]
            .filter((part: string): boolean => part !== '')
            .join(' ');
    }

    /** A granted root alias followed by the request's relative path; `.` names the root itself. */
    static #folderPath(args: ConnectorActivityArguments, field: string): string {
        const root: string = args.text('rootId');
        const path: string = args.text(field);
        if (path === '' || path === '.') {
            return root;
        }
        return root === '' ? path : `${root}/${path}`;
    }

    /** Only the host and path; user information, the query string and the fragment are dropped. */
    static #address(raw: string): string {
        if (raw === '' || !URL.canParse(raw)) {
            return '';
        }
        const url: URL = new URL(raw);
        return url.host + url.pathname;
    }

    static #pointerTitle(action: string): string {
        switch (action) {
            case HostDesktopPointerAction.Click:
                return 'Clicking';
            case HostDesktopPointerAction.Down:
                return 'Pressing a mouse button';
            case HostDesktopPointerAction.Up:
                return 'Letting go of a mouse button';
            default:
                return 'Moving the mouse';
        }
    }

    static #pointer(args: ConnectorActivityArguments): string {
        const x: number | null = args.number('x');
        const y: number | null = args.number('y');
        const button: string = args.text('button');
        const place: string = x === null || y === null ? '' : `at ${x}, ${y}`;
        return button === '' ? place : `${button} button ${place}`;
    }

    static #keyTitle(action: string): string {
        switch (action) {
            case HostDesktopKeyAction.Down:
                return 'Holding a key';
            case HostDesktopKeyAction.Up:
                return 'Letting go of a key';
            default:
                return 'Pressing keys';
        }
    }

    /** Named keys such as Enter are shown; a single letter or digit is not, so pressed keys cannot spell a secret. */
    static #key(key: string): string {
        if (key === '') {
            return '';
        }
        return key.length === 1 ? 'a letter or number' : key;
    }

    /** Only how much text is typed, never the text itself. */
    static #characters(text: string): string {
        let count: number = 0;
        for (let index: number = 0; index < text.length; index++) {
            const unit: number = text.charCodeAt(index);
            if (unit < 0xdc00 || unit > 0xdfff) {
                count += 1;
            }
        }
        if (count === 0) {
            return '';
        }
        return count === 1 ? '1 character' : `${count} characters`;
    }
}
