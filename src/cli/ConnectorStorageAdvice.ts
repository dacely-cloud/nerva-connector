// SPDX-FileCopyrightText: 2026 Dacely <business@dacely.com>
// SPDX-License-Identifier: LicenseRef-Proprietary

import {
    WindowsStateCheck,
    WindowsStateScope,
    type WindowsStateDiagnostic,
} from '../windows/WindowsStateProtocol.js';

/**
 * Names the Windows folder a storage check refused and how to repair it, from the helper's fixed diagnostic.
 *
 * @remarks
 * The helper reports only which part of the protected path failed and which check refused it, never a path,
 * account or permission entry. Each part maps to the folder it always names on the default storage path, written
 * with the Command Prompt variables the README uses, so the person can inspect it with `icacls` themselves. The
 * text is fixed and local; nothing remote selects or fills it.
 */
export class ConnectorStorageAdvice {
    static readonly #folders: Readonly<Record<WindowsStateScope, string>> = {
        [WindowsStateScope.Volume]:
            'Folder: the root of the drive that holds your user profile, such as C:\\',
        [WindowsStateScope.ProfileAncestor]:
            'Folder: your user profile folder, %USERPROFILE%, or the folder above it, such as C:\\Users',
        [WindowsStateScope.LocalAppDataParent]: 'Folder: %USERPROFILE%\\AppData',
        [WindowsStateScope.LocalAppData]: 'Folder: %LOCALAPPDATA%',
        [WindowsStateScope.NervaFolder]: 'Folder: %LOCALAPPDATA%\\Nerva',
        [WindowsStateScope.ConnectorState]:
            'Folder: the connector storage, %USERPROFILE%\\.nerva-connector-state or %LOCALAPPDATA%\\Nerva\\Connector, or a folder inside it',
        [WindowsStateScope.OtherDirectory]:
            "Folder: one outside the connector's usual storage path, such as a folder named in its configuration",
        [WindowsStateScope.StateObject]:
            'Folder: a file or folder inside %USERPROFILE%\\.nerva-connector-state or %LOCALAPPDATA%\\Nerva\\Connector',
    };
    static readonly #repairs: Readonly<Record<WindowsStateCheck, string>> = {
        [WindowsStateCheck.UnexpectedPermission]:
            'Problem: another account has access that is not allowed there. Fix: run icacls "<folder>" in Command Prompt and remove that account with icacls "<folder>" /remove "<account>". Keep the folder and its files.',
        [WindowsStateCheck.UnexpectedOwner]:
            'Problem: another account owns it. Fix: as an administrator, run icacls "<folder>" /setowner "%USERNAME%".',
        [WindowsStateCheck.InheritedPermissions]:
            'Problem: a private connector file or folder inherits permissions. Fix: run icacls "<folder>" /inheritance:r so only your account and SYSTEM keep access.',
        [WindowsStateCheck.MissingPermission]:
            'Problem: your account or SYSTEM lost full control of it. Fix: run icacls "<folder>" /grant "%USERNAME%":(OI)(CI)F /grant SYSTEM:(OI)(CI)F.',
        [WindowsStateCheck.ReparsePoint]:
            'Problem: it is a link or junction, such as a redirected or synced folder. Fix: keep it a regular folder on a local drive.',
        [WindowsStateCheck.AccessDenied]:
            'Problem: Windows denied access. Fix: run the connector as the account that set it up, and allow it in your security software.',
        [WindowsStateCheck.UnsupportedVolume]:
            'Problem: the drive lacks the secure file operations the connector needs, as FAT, exFAT and network drives do. Fix: keep your profile on a local NTFS drive.',
        [WindowsStateCheck.UnexpectedFileType]:
            'Problem: it is not the kind of file or folder the connector created. Fix: share this check with support; do not delete connector files.',
        [WindowsStateCheck.DescriptorUnreadable]:
            'Problem: Windows would not let the connector read its permissions. Fix: give your account the "Read permissions" right on it.',
        [WindowsStateCheck.InvalidDescriptor]:
            'Problem: its permissions could not be read as a valid list. Fix: share this check with support.',
    };

    /**
     * Two lines for the person: the folder that was refused, then what is wrong with it and how to fix it.
     *
     * @param diagnostic - The helper's `scope/check` diagnostic
     * @returns Both lines, or none for a diagnostic outside the fixed vocabulary
     */
    public static lines(diagnostic: WindowsStateDiagnostic): readonly string[] {
        const [scope, check]: readonly string[] = diagnostic.split('/');
        const matchedScope: WindowsStateScope | undefined = Object.values(WindowsStateScope).find(
            (value: WindowsStateScope): boolean => value === scope,
        );
        const matchedCheck: WindowsStateCheck | undefined = Object.values(WindowsStateCheck).find(
            (value: WindowsStateCheck): boolean => value === check,
        );
        if (matchedScope === undefined || matchedCheck === undefined) {
            return [];
        }
        return [this.#folders[matchedScope], this.#repairs[matchedCheck]];
    }
}
