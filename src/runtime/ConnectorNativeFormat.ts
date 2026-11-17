// SPDX-FileCopyrightText: 2026 Nerva contributors
// SPDX-License-Identifier: LicenseRef-Proprietary

/** The build and runtime agree on the native executable format and processor before using a helper. */
export class ConnectorNativeFormat {
    /** Recognizes 64-bit little-endian ELF executables and thin executable Mach-O files on supported targets. */
    public static matches(
        header: Buffer,
        platform: string = process.platform,
        architecture: string = process.arch,
    ): boolean {
        if (header.byteLength < 64) {
            return false;
        }
        if (platform === 'darwin') {
            const cpu: number =
                architecture === 'x64' ? 0x01000007 : architecture === 'arm64' ? 0x0100000c : 0;
            return (
                cpu !== 0 &&
                header.readUInt32LE(0) === 0xfeedfacf &&
                header.readUInt32LE(4) === cpu &&
                header.readUInt32LE(12) === 2
            );
        }
        const machine: number = architecture === 'x64' ? 62 : architecture === 'arm64' ? 183 : 0;
        return (
            platform === 'linux' &&
            machine !== 0 &&
            header.subarray(0, 4).toString('hex') === '7f454c46' &&
            header[4] === 2 &&
            header[5] === 1 &&
            header.readUInt16LE(18) === machine &&
            [2, 3].includes(header.readUInt16LE(16))
        );
    }
}
