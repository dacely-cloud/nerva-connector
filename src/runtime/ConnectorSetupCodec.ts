// SPDX-FileCopyrightText: 2026 Nerva contributors
// SPDX-License-Identifier: LicenseRef-Proprietary

import { homedir, hostname } from 'node:os';
import { isAbsolute, join, resolve, sep } from 'node:path';
import { Boundary } from 'nerva-connector-protocol/protocol/Boundary.js';
import { ConnectorEnrollmentCodec } from 'nerva-connector-protocol/protocol/ConnectorEnrollmentCodec.js';
import { ConnectorInstructionsCodec } from 'nerva-connector-protocol/protocol/ConnectorInstructionsCodec.js';
import { ProtectedFiles } from '../local/ProtectedFiles.js';
import {
    ConnectorSetupAccess,
    type ConnectorSetupPreferences,
    type ConnectorSetupProfile,
} from './ConnectorSetupProfile.js';

/** Only a complete current local setup contract is accepted; corrupt saved choices are never silently reset. */
export class ConnectorSetupCodec {
    /** Enter uses one stable home-relative task directory on Linux and Windows. */
    public static defaults(): ConnectorSetupPreferences {
        return {
            name: ConnectorEnrollmentCodec.name(hostname().slice(0, 128) || 'My computer'),
            tasksDirectory: join(homedir(), 'Nexa Tasks'),
            localInstructions: '',
            access: ConnectorSetupAccess.PairingOnly,
        };
    }

    /** Tilde expansion is a local terminal convenience, never shell expansion. */
    public static tasksDirectory(input: string): string {
        const expanded: string =
            input === '~'
                ? homedir()
                : input.startsWith('~/') || input.startsWith('~\\')
                  ? join(homedir(), input.slice(2))
                  : input;
        ProtectedFiles.path(expanded);
        if (/[\p{Cc}\p{Cf}]/u.test(expanded)) {
            throw new Error('Choose a task folder without terminal control characters');
        }
        const path: string = resolve(expanded);
        if (!isAbsolute(path) || resolve(path, '..') === path) {
            throw new Error('Choose a task folder rather than a filesystem root');
        }
        return path;
    }

    /** The connector's private identity and setup directories cannot become its task workspace. */
    public static distinct(tasksDirectory: string, installationDirectory: string): void {
        const tasks: string =
            process.platform === 'win32' ? tasksDirectory.toLowerCase() : tasksDirectory;
        const installation: string =
            process.platform === 'win32'
                ? installationDirectory.toLowerCase()
                : installationDirectory;
        if (
            tasks === installation ||
            tasks.startsWith(installation + sep) ||
            installation.startsWith(tasks + sep)
        ) {
            throw new Error('Choose a task folder outside the connector installation');
        }
    }

    /** A persisted profile supplies canonical paths and a nonzero exact settings revision. */
    public static read(raw: unknown): ConnectorSetupProfile {
        const value: Readonly<Record<string, unknown>> = Boundary.record(raw, [
            'version',
            'revision',
            'name',
            'tasksDirectory',
            'localInstructions',
            'access',
        ]);
        if (value['version'] !== 1) {
            throw new Error('Unsupported connector setup version');
        }
        const revision: bigint = Boundary.integer(value['revision']);
        const access: ConnectorSetupAccess | undefined = Object.values(ConnectorSetupAccess).find(
            (entry: ConnectorSetupAccess): boolean => entry === value['access'],
        );
        const name: string = ConnectorEnrollmentCodec.name(value['name']);
        if (
            revision === 0n ||
            access === undefined ||
            !name.isWellFormed() ||
            /[\p{Cc}\p{Cf}]/u.test(name)
        ) {
            throw new Error('Invalid connector setup profile');
        }
        if (typeof value['tasksDirectory'] !== 'string') {
            throw new Error('Invalid connector task directory');
        }
        const tasksDirectory: string = this.tasksDirectory(value['tasksDirectory']);
        if (tasksDirectory !== value['tasksDirectory']) {
            throw new Error('Canonical connector task directory required');
        }
        return {
            revision,
            name,
            tasksDirectory,
            localInstructions: ConnectorInstructionsCodec.text(value['localInstructions']),
            access,
        };
    }

    /** JSON persistence preserves exact revision strings. */
    public static encode(profile: ConnectorSetupProfile): string {
        const json: string = JSON.stringify({
            version: 1,
            ...profile,
            revision: profile.revision.toString(),
        });
        this.read(JSON.parse(json));
        return json;
    }
}
