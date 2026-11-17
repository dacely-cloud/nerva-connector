// SPDX-FileCopyrightText: 2026 Nerva contributors
// SPDX-License-Identifier: LicenseRef-Proprietary

import { expect, it } from 'vitest';
import { ConnectorNativeFormat } from '../src/runtime/ConnectorNativeFormat.js';

it('build and runtime reject a native helper from another operating system or processor', (): void => {
    for (const architecture of ['x64', 'arm64']) {
        const elf: Buffer = Buffer.alloc(64);
        elf.write('7f454c46', 'hex');
        elf[4] = 2;
        elf[5] = 1;
        elf.writeUInt16LE(3, 16);
        elf.writeUInt16LE(architecture === 'x64' ? 62 : 183, 18);
        const mach: Buffer = Buffer.alloc(64);
        mach.writeUInt32LE(0xfeedfacf, 0);
        mach.writeUInt32LE(architecture === 'x64' ? 0x01000007 : 0x0100000c, 4);
        mach.writeUInt32LE(2, 12);
        const other: string = architecture === 'x64' ? 'arm64' : 'x64';
        expect(ConnectorNativeFormat.matches(elf, 'linux', architecture)).toBe(true);
        expect(ConnectorNativeFormat.matches(mach, 'darwin', architecture)).toBe(true);
        expect(ConnectorNativeFormat.matches(elf, 'linux', other)).toBe(false);
        expect(ConnectorNativeFormat.matches(mach, 'darwin', other)).toBe(false);
        expect(ConnectorNativeFormat.matches(mach, 'linux', architecture)).toBe(false);
        expect(ConnectorNativeFormat.matches(elf, 'darwin', architecture)).toBe(false);
        expect(ConnectorNativeFormat.matches(mach.subarray(0, 63), 'darwin', architecture)).toBe(
            false,
        );
        mach.writeUInt32LE(6, 12);
        expect(ConnectorNativeFormat.matches(mach, 'darwin', architecture)).toBe(false);
    }
});
