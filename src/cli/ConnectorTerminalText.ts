// SPDX-FileCopyrightText: 2026 Dacely <business@dacely.com>
// SPDX-License-Identifier: LicenseRef-Proprietary

/** Measures, sanitizes and wraps text in terminal cells so caller text cannot move the cursor or break layout. */
export class ConnectorTerminalText {
    /** Display-safe text: newlines become a visible mark and control or format characters are removed. */
    public static safe(value: string): string {
        return value
            .slice(0, 32768)
            .toWellFormed()
            .replace(/\r\n|\r|\n/gu, ' ↵ ')
            .replace(/\t/gu, ' ')
            .replace(/[\p{Cc}\p{Cf}]/gu, '');
    }
    /** Terminal cells one character occupies: 0 for combining marks, 2 for wide glyphs, otherwise 1. */
    public static cells(character: string): number {
        const code: number = character.codePointAt(0) ?? 0;
        if (/\p{Mark}/u.test(character)) {
            return 0;
        }
        return /\p{Extended_Pictographic}/u.test(character) ||
            (code >= 0x1100 &&
                (code <= 0x115f ||
                    (code >= 0x2329 && code <= 0x232a) ||
                    (code >= 0x2e80 && code <= 0xa4cf) ||
                    (code >= 0xac00 && code <= 0xd7a3) ||
                    (code >= 0xf900 && code <= 0xfaff) ||
                    (code >= 0xfe10 && code <= 0xfe6f) ||
                    (code >= 0xff00 && code <= 0xff60) ||
                    (code >= 0x20000 && code <= 0x3fffd)))
            ? 2
            : 1;
    }
    /** Terminal cells a string occupies. */
    public static width(value: string): number {
        return Array.from(value).reduce(
            (total: number, character: string): number => total + this.cells(character),
            0,
        );
    }
    /** The longest prefix that fits in `width` cells. */
    public static clip(value: string, width: number): string {
        let result: string = '';
        let used: number = 0;
        let characters: number = 0;
        for (const character of value) {
            const cells: number = this.cells(character);
            if (used + cells > width || characters >= 192) {
                break;
            }
            result += character;
            used += cells;
            characters += 1;
        }
        return result;
    }
    /** Right-pads with spaces to exactly `width` cells when shorter. */
    public static pad(value: string, width: number): string {
        return value + ' '.repeat(Math.max(0, width - this.width(value)));
    }
    /** Word-wraps sanitized text into at most `maximum` rows, ending a truncated last row with an ellipsis. */
    public static wrap(value: string, width: number, maximum: number): readonly string[] {
        const characters: string[] = Array.from(this.safe(value));
        const lines: string[] = [];
        let offset: number = 0;
        while (offset < characters.length && lines.length < maximum) {
            let line: string = '';
            let used: number = 0;
            let count: number = 0;
            let spaceOffset: number = -1;
            let spaceLength: number = 0;
            while (offset < characters.length) {
                const character: string = characters[offset] ?? '';
                const cells: number = this.cells(character);
                if ((used + cells > width && line !== '') || count >= 192) {
                    break;
                }
                offset++;
                count += 1;
                if (cells <= width) {
                    if (character === ' ') {
                        spaceOffset = offset;
                        spaceLength = line.length;
                    }
                    line += character;
                    used += cells;
                }
            }
            if (offset < characters.length && spaceOffset >= 0 && lines.length + 1 < maximum) {
                offset = spaceOffset;
                line = line.slice(0, spaceLength);
            }
            if (offset < characters.length && lines.length + 1 === maximum) {
                line = this.clip(line, Math.max(0, width - 1)) + '…';
            }
            lines.push(line);
        }
        return lines;
    }
}
