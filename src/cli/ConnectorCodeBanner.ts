// SPDX-FileCopyrightText: 2026 Dacely <business@dacely.com>
// SPDX-License-Identifier: LicenseRef-Proprietary

/**
 * Five-by-five pixel glyphs for the pairing-code alphabet, one string per pixel row.
 *
 * @remarks
 * `#` marks a lit pixel. The alphabet matches the server's unambiguous code characters
 * (no I, O, 0 or 1) plus the group separator.
 */
const ConnectorCodeGlyphs = {
    A: ['.###.', '#...#', '#####', '#...#', '#...#'],
    B: ['####.', '#...#', '####.', '#...#', '####.'],
    C: ['.####', '#....', '#....', '#....', '.####'],
    D: ['####.', '#...#', '#...#', '#...#', '####.'],
    E: ['#####', '#....', '####.', '#....', '#####'],
    F: ['#####', '#....', '####.', '#....', '#....'],
    G: ['.####', '#....', '#..##', '#...#', '.###.'],
    H: ['#...#', '#...#', '#####', '#...#', '#...#'],
    J: ['..###', '...#.', '...#.', '#..#.', '.##..'],
    K: ['#...#', '#..#.', '###..', '#..#.', '#...#'],
    L: ['#....', '#....', '#....', '#....', '#####'],
    M: ['#...#', '##.##', '#.#.#', '#...#', '#...#'],
    N: ['#...#', '##..#', '#.#.#', '#..##', '#...#'],
    P: ['####.', '#...#', '####.', '#....', '#....'],
    Q: ['.###.', '#...#', '#...#', '#..##', '.####'],
    R: ['####.', '#...#', '####.', '#..#.', '#...#'],
    S: ['.####', '#....', '.###.', '....#', '####.'],
    T: ['#####', '..#..', '..#..', '..#..', '..#..'],
    U: ['#...#', '#...#', '#...#', '#...#', '.###.'],
    V: ['#...#', '#...#', '#...#', '.#.#.', '..#..'],
    W: ['#...#', '#...#', '#.#.#', '##.##', '#...#'],
    X: ['#...#', '.#.#.', '..#..', '.#.#.', '#...#'],
    Y: ['#...#', '.#.#.', '..#..', '..#..', '..#..'],
    Z: ['#####', '...#.', '..#..', '.#...', '#####'],
    '2': ['.###.', '#...#', '..##.', '.#...', '#####'],
    '3': ['####.', '....#', '.###.', '....#', '####.'],
    '4': ['#..#.', '#..#.', '#####', '...#.', '...#.'],
    '5': ['#####', '#....', '####.', '....#', '####.'],
    '6': ['.###.', '#....', '####.', '#...#', '.###.'],
    '7': ['#####', '....#', '...#.', '..#..', '..#..'],
    '8': ['.###.', '#...#', '.###.', '#...#', '.###.'],
    '9': ['.###.', '#...#', '.####', '....#', '.###.'],
    '-': ['.....', '.....', '.###.', '.....', '.....'],
} as const satisfies Readonly<Record<string, readonly string[]>>;

/** Renders a short pairing code in large half-block type so it can be read from across a desk. */
export class ConnectorCodeBanner {
    /** Glyph rows are five pixels tall; half blocks pack two pixel rows into one terminal row. */
    public static readonly rows: number = 3;
    static readonly #glyphs: ReadonlyMap<string, readonly string[]> = new Map(
        Object.entries(ConnectorCodeGlyphs),
    );

    /** Terminal columns needed for the large rendering of `code`. */
    public static width(code: string): number {
        const count: number = Array.from(code).length;
        return count === 0 ? 0 : count * 6 - 1;
    }

    /**
     * Large rows for `code`, or `null` when it contains an unsupported character or does not fit.
     *
     * @param code - A pairing code using the unambiguous server alphabet
     * @param width - Available terminal columns
     */
    public static render(code: string, width: number): readonly string[] | null {
        const characters: readonly string[] = Array.from(code.toUpperCase());
        if (characters.length === 0 || characters.length > 16 || this.width(code) > width) {
            return null;
        }
        const glyphs: (readonly string[])[] = [];
        for (const character of characters) {
            const glyph: readonly string[] | undefined = this.#glyphs.get(character);
            if (glyph === undefined) {
                return null;
            }
            glyphs.push(glyph);
        }
        const rows: string[] = [];
        for (let pair: number = 0; pair < 5; pair += 2) {
            rows.push(
                glyphs
                    .map((glyph: readonly string[]): string =>
                        this.#halfRow(glyph[pair] ?? '', glyph[pair + 1] ?? ''),
                    )
                    .join(' ')
                    .trimEnd(),
            );
        }
        return rows;
    }

    static #halfRow(top: string, bottom: string): string {
        let row: string = '';
        for (let column: number = 0; column < 5; column++) {
            const upper: boolean = top[column] === '#';
            const lower: boolean = bottom[column] === '#';
            row += upper && lower ? '█' : upper ? '▀' : lower ? '▄' : ' ';
        }
        return row;
    }
}
