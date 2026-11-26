// SPDX-FileCopyrightText: 2026 Dacely <business@dacely.com>
// SPDX-License-Identifier: LicenseRef-Proprietary

/** What a compiled Windows program says about itself in Explorer, Task Manager and its Properties window. */
export interface WindowsProgramIdentity {
    /** Shown as the program's description, for example in Task Manager. */
    readonly description: string;
    /** The file name the program is published under. */
    readonly fileName: string;
    /** Dotted numeric version with one to four parts, such as `0.1.0`. */
    readonly version: string;
}

/** One image of a Windows icon file, as its directory entry describes it. */
interface IconImage {
    readonly width: number;
    readonly height: number;
    readonly colors: number;
    readonly planes: number;
    readonly bitCount: number;
    readonly bytes: Buffer;
}

/**
 * Writes the Win32 resource file (.res) compiled into the setup program, its uninstaller and the launcher.
 *
 * @remarks
 * It carries the program icon, an application manifest and version information. The manifest asks to run as the
 * invoking user: without one, Windows treats a program named like an installer as one and asks for an administrator,
 * which would install into the administrator's profile instead of the person's own. It also declares Windows 10 and
 * 11 support and system DPI awareness so the setup window is sharp. Both C# compilers take the file through their
 * win32 resource option, which replaces the icon and version information they would otherwise generate.
 */
export class ConnectorWindowsResource {
    static readonly #icon: number = 3;
    static readonly #groupIcon: number = 14;
    static readonly #version: number = 16;
    static readonly #manifest: number = 24;
    static readonly #english: number = 0x0409;

    /**
     * Builds the resource file.
     *
     * @param icon - The bytes of a .ico file
     * @param identity - The program's description, file name and version
     * @returns The complete .res bytes
     */
    public static build(icon: Buffer, identity: WindowsProgramIdentity): Buffer {
        const images: readonly IconImage[] = this.#images(icon);
        const parts: Buffer[] = [this.#entry(0, 0, Buffer.alloc(0), 0)];
        images.forEach((image: IconImage, index: number): void => {
            parts.push(this.#entry(this.#icon, index + 1, image.bytes, 0x1010));
        });
        const group: Buffer = Buffer.alloc(6 + 14 * images.length);
        group.writeUInt16LE(0, 0);
        group.writeUInt16LE(1, 2);
        group.writeUInt16LE(images.length, 4);
        images.forEach((image: IconImage, index: number): void => {
            const offset: number = 6 + 14 * index;
            group.writeUInt8(image.width % 256, offset);
            group.writeUInt8(image.height % 256, offset + 1);
            group.writeUInt8(image.colors, offset + 2);
            group.writeUInt8(0, offset + 3);
            group.writeUInt16LE(image.planes, offset + 4);
            group.writeUInt16LE(image.bitCount, offset + 6);
            group.writeUInt32LE(image.bytes.byteLength, offset + 8);
            group.writeUInt16LE(index + 1, offset + 12);
        });
        parts.push(this.#entry(this.#groupIcon, 1, group, 0x1030));
        parts.push(this.#entry(this.#version, 1, this.#versionInfo(identity), 0x0030));
        parts.push(
            this.#entry(
                this.#manifest,
                1,
                Buffer.from(this.#manifestXml(identity), 'utf8'),
                0x0030,
            ),
        );
        return Buffer.concat(parts);
    }

    /** Four numeric version parts, padding missing ones with zero. */
    static #parts(version: string): readonly [number, number, number, number] {
        const parts: number[] = version.split('.').map((part: string): number => {
            if (!/^(0|[1-9][0-9]{0,4})$/u.test(part) || Number(part) > 65535) {
                throw new Error('Windows program versions are one to four numbers up to 65535');
            }
            return Number(part);
        });
        if (parts.length < 1 || parts.length > 4) {
            throw new Error('Windows program versions are one to four numbers up to 65535');
        }
        while (parts.length < 4) {
            parts.push(0);
        }
        return [parts[0] ?? 0, parts[1] ?? 0, parts[2] ?? 0, parts[3] ?? 0];
    }

    static #images(icon: Buffer): readonly IconImage[] {
        if (icon.byteLength < 6 || icon.readUInt16LE(0) !== 0 || icon.readUInt16LE(2) !== 1) {
            throw new Error('The program icon is not a Windows .ico file');
        }
        const count: number = icon.readUInt16LE(4);
        if (count < 1 || count > 32 || icon.byteLength < 6 + 16 * count) {
            throw new Error('The program icon has an invalid image directory');
        }
        const images: IconImage[] = [];
        for (let index: number = 0; index < count; index++) {
            const entry: number = 6 + 16 * index;
            const size: number = icon.readUInt32LE(entry + 8);
            const offset: number = icon.readUInt32LE(entry + 12);
            if (offset + size > icon.byteLength || size === 0) {
                throw new Error('The program icon has an image outside the file');
            }
            images.push({
                width: icon.readUInt8(entry) || 256,
                height: icon.readUInt8(entry + 1) || 256,
                colors: icon.readUInt8(entry + 2),
                planes: icon.readUInt16LE(entry + 4),
                bitCount: icon.readUInt16LE(entry + 6),
                bytes: icon.subarray(offset, offset + size),
            });
        }
        return images;
    }

    /** One resource with an ordinal type and name, English (United States), padded to a four-byte boundary. */
    static #entry(type: number, name: number, data: Buffer, flags: number): Buffer {
        const header: Buffer = Buffer.alloc(32);
        header.writeUInt32LE(data.byteLength, 0);
        header.writeUInt32LE(32, 4);
        header.writeUInt16LE(0xffff, 8);
        header.writeUInt16LE(type, 10);
        header.writeUInt16LE(0xffff, 12);
        header.writeUInt16LE(name, 14);
        header.writeUInt32LE(0, 16);
        header.writeUInt16LE(flags, 20);
        header.writeUInt16LE(type === 0 ? 0 : this.#english, 22);
        header.writeUInt32LE(0, 24);
        header.writeUInt32LE(0, 28);
        return Buffer.concat([header, data, Buffer.alloc((4 - (data.byteLength % 4)) % 4)]);
    }

    static #manifestXml(identity: WindowsProgramIdentity): string {
        return [
            '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>',
            '<assembly xmlns="urn:schemas-microsoft-com:asm.v1" manifestVersion="1.0">',
            '  <assemblyIdentity version="' +
                this.#parts(identity.version).join('.') +
                '" name="Nerva.Connector" type="win32"/>',
            '  <trustInfo xmlns="urn:schemas-microsoft-com:asm.v3">',
            '    <security><requestedPrivileges><requestedExecutionLevel level="asInvoker" uiAccess="false"/></requestedPrivileges></security>',
            '  </trustInfo>',
            '  <compatibility xmlns="urn:schemas-microsoft-com:compatibility.v1">',
            '    <application><supportedOS Id="{8e0f7a12-bfb3-4fe8-b9a5-48fd50a15a9a}"/></application>',
            '  </compatibility>',
            '  <application xmlns="urn:schemas-microsoft-com:asm.v3">',
            '    <windowsSettings><dpiAware xmlns="http://schemas.microsoft.com/SMI/2005/WindowsSettings">true</dpiAware></windowsSettings>',
            '  </application>',
            '</assembly>',
            '',
        ].join('\r\n');
    }

    /** VS_VERSIONINFO with fixed file information and one English (United States), Unicode string table. */
    static #versionInfo(identity: WindowsProgramIdentity): Buffer {
        const [major, minor, patch, build]: readonly [number, number, number, number] = this.#parts(
            identity.version,
        );
        const fixed: Buffer = Buffer.alloc(52);
        fixed.writeUInt32LE(0xfeef04bd, 0);
        fixed.writeUInt32LE(0x00010000, 4);
        fixed.writeUInt32LE(((major << 16) | minor) >>> 0, 8);
        fixed.writeUInt32LE(((patch << 16) | build) >>> 0, 12);
        fixed.writeUInt32LE(((major << 16) | minor) >>> 0, 16);
        fixed.writeUInt32LE(((patch << 16) | build) >>> 0, 20);
        fixed.writeUInt32LE(0x3f, 24);
        fixed.writeUInt32LE(0, 28);
        fixed.writeUInt32LE(0x00040004, 32);
        fixed.writeUInt32LE(1, 36);
        const dotted: string = [major, minor, patch, build].join('.');
        const strings: readonly (readonly [string, string])[] = [
            ['CompanyName', 'Nerva'],
            ['FileDescription', identity.description],
            ['FileVersion', dotted],
            ['InternalName', identity.fileName.replace(/\.exe$/u, '')],
            ['LegalCopyright', 'Copyright Dacely'],
            ['OriginalFilename', identity.fileName],
            ['ProductName', 'Nerva Connector'],
            ['ProductVersion', dotted],
        ];
        const table: Buffer = this.#node(
            '040904b0',
            Buffer.alloc(0),
            0,
            1,
            strings.map(([key, value]: readonly [string, string]): Buffer => {
                const text: Buffer = Buffer.from(value + '\0', 'utf16le');
                return this.#node(key, text, text.byteLength / 2, 1, []);
            }),
        );
        const translation: Buffer = Buffer.alloc(4);
        translation.writeUInt16LE(this.#english, 0);
        translation.writeUInt16LE(1200, 2);
        return this.#node('VS_VERSION_INFO', fixed, fixed.byteLength, 0, [
            this.#node('StringFileInfo', Buffer.alloc(0), 0, 1, [table]),
            this.#node('VarFileInfo', Buffer.alloc(0), 0, 1, [
                this.#node('Translation', translation, translation.byteLength, 0, []),
            ]),
        ]);
    }

    /** One version-information node: length, value length, type, key, then value and children on 4-byte boundaries. */
    static #node(
        key: string,
        value: Buffer,
        valueLength: number,
        type: number,
        children: readonly Buffer[],
    ): Buffer {
        const header: Buffer = Buffer.alloc(6);
        const parts: Buffer[] = [header, Buffer.from(key + '\0', 'utf16le')];
        let length: number = 6 + (key.length + 1) * 2;
        const align: () => void = (): void => {
            const padding: number = (4 - (length % 4)) % 4;
            parts.push(Buffer.alloc(padding));
            length += padding;
        };
        align();
        parts.push(value);
        length += value.byteLength;
        for (const child of children) {
            align();
            parts.push(child);
            length += child.byteLength;
        }
        header.writeUInt16LE(length, 0);
        header.writeUInt16LE(valueLength, 2);
        header.writeUInt16LE(type, 4);
        return Buffer.concat(parts);
    }
}
