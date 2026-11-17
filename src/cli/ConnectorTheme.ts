// SPDX-FileCopyrightText: 2026 Nerva contributors
// SPDX-License-Identifier: LicenseRef-Proprietary

/** One 24-bit color channel triple; terminal sequences are derived from these values only. */
export type ConnectorRgb = readonly [number, number, number];

/** The Nerva terminal palette shared with Nerva Code: brand orange on neutral greys over a quiet dark field. */
export const ConnectorColor = {
    Background: [10, 10, 10],
    Text: [238, 238, 238],
    Strong: [255, 255, 255],
    Muted: [128, 128, 128],
    Dim: [92, 92, 92],
    Faint: [60, 60, 60],
    Accent: [255, 106, 42],
    AccentSoft: [255, 162, 102],
    AccentDim: [122, 58, 30],
    Agent: [154, 164, 178],
    Success: [127, 216, 143],
    Warning: [229, 192, 123],
    Error: [224, 108, 117],
} as const satisfies Readonly<Record<string, ConnectorRgb>>;

/** Shared ANSI styles for every connector screen; caller text never supplies escape sequences. */
export class ConnectorTheme {
    /** The product name shown beside the logo. */
    public static readonly product: string = 'Nerva Connector';
    /** Clears bold and colors before each styled row. */
    public static readonly reset: string = '\x1b[0m';
    /** Near-black page background used by the console and setup screens. */
    public static readonly background: string = ConnectorTheme.backgroundOf(
        ConnectorColor.Background,
    );
    /** Normal body text. */
    public static readonly text: string = ConnectorTheme.foregroundOf(ConnectorColor.Text);
    /** Bold white titles. */
    public static readonly strong: string =
        '\x1b[1m' + ConnectorTheme.foregroundOf(ConnectorColor.Strong);
    /** Secondary text, captions and labels. */
    public static readonly muted: string = ConnectorTheme.foregroundOf(ConnectorColor.Muted);
    /** Passive hints that must never compete with content. */
    public static readonly dim: string = ConnectorTheme.foregroundOf(ConnectorColor.Dim);
    /** Dividers and inactive borders. */
    public static readonly faint: string = ConnectorTheme.foregroundOf(ConnectorColor.Faint);
    /** Nerva orange for focus, the prompt marker and the pairing code. */
    public static readonly accent: string = ConnectorTheme.foregroundOf(ConnectorColor.Accent);
    /** Bold Nerva orange for content that must stand out. */
    public static readonly accentStrong: string =
        '\x1b[1m' + ConnectorTheme.foregroundOf(ConnectorColor.Accent);
    /** Lighter brand tint for the wordmark context, links and actions. */
    public static readonly accentSoft: string = ConnectorTheme.foregroundOf(
        ConnectorColor.AccentSoft,
    );
    /** Quiet brand chrome such as progress tracks. */
    public static readonly accentDim: string = ConnectorTheme.foregroundOf(
        ConnectorColor.AccentDim,
    );
    /** The low-chroma tone that labels agents. */
    public static readonly agent: string = ConnectorTheme.foregroundOf(ConnectorColor.Agent);
    /** The focused choice: brand orange text, no background block. */
    public static readonly selected: string = '\x1b[1m' + ConnectorTheme.accent;
    /** Completed and connected states. */
    public static readonly success: string = ConnectorTheme.foregroundOf(ConnectorColor.Success);
    /** Cautions and recoverable problems. */
    public static readonly warning: string = ConnectorTheme.foregroundOf(ConnectorColor.Warning);
    /** Failures that need the user's attention. */
    public static readonly error: string = ConnectorTheme.foregroundOf(ConnectorColor.Error);

    /** A 24-bit foreground sequence for a palette color. */
    public static foregroundOf(color: ConnectorRgb): string {
        return '\x1b[38;2;' + color.join(';') + 'm';
    }

    /** A 24-bit background sequence for a palette color. */
    public static backgroundOf(color: ConnectorRgb): string {
        return '\x1b[48;2;' + color.join(';') + 'm';
    }
}
