// SPDX-FileCopyrightText: 2026 Dacely <business@dacely.com>
// SPDX-License-Identifier: LicenseRef-Proprietary

/** A parsed `major.minor.patch` runtime version. */
type ConnectorRuntimeVersion = readonly [number, number, number];

/** One supported Node.js release line and the oldest release whose built-in WebSocket enforces the connector's parser limits. */
interface ConnectorRuntimeLine {
    readonly nodeMajor: number;
    /** The oldest Node.js release of this line that bundles the limit-enforcing client. */
    readonly oldestNode: ConnectorRuntimeVersion;
    readonly clientMajor: number;
    /** The oldest bundled Undici minor release of this line that enforces the per-message fragment budget. */
    readonly oldestClientMinor: number;
}

/**
 * The running Node.js cannot enforce the connector's native WebSocket limits.
 *
 * @remarks
 * The message names only runtime version strings, so it is safe to show as-is.
 */
export class ConnectorRuntimeUnsupported extends Error {
    /** Creates the error from the versions that were checked, or `null` for an unreadable one. */
    public constructor(
        public readonly nodeVersion: string | null,
        public readonly clientVersion: string | null,
    ) {
        super(
            'Nerva Connector needs Node.js ' +
                ConnectorNodeRuntime.supportedText +
                '; this computer has ' +
                ConnectorRuntimeUnsupported.#found(nodeVersion, clientVersion) +
                '. Install Node.js 26 LTS from https://nodejs.org, then start the connector again.',
        );
        this.name = 'ConnectorRuntimeUnsupported';
    }

    /** One plain sentence naming the found runtime and the fix. */
    public get advice(): string {
        return (
            'Install Node.js 26 LTS from nodejs.org (this computer has ' +
            ConnectorRuntimeUnsupported.#found(this.nodeVersion, this.clientVersion) +
            '), then try again.'
        );
    }

    static #found(nodeVersion: string | null, clientVersion: string | null): string {
        if (nodeVersion === null) {
            return 'an unrecognized Node.js version';
        }
        return ConnectorNodeRuntime.nodeSupported(nodeVersion)
            ? 'a Node.js ' +
                  nodeVersion +
                  ' build with an older built-in WebSocket client (Undici ' +
                  (clientVersion ?? 'unknown') +
                  ')'
            : 'Node.js ' + nodeVersion;
    }
}

/**
 * One runtime policy is shared by release preparation, initial installation and native WebSocket connection.
 *
 * @remarks
 * The connector's transport relies on Node's built-in WebSocket reading per-connection payload
 * and fragment limits from its dispatcher. The fragment budget is enforced from Undici 8.5.0
 * (Node.js 26.3.1) and its 7.28.0 backport (Node.js 24.17.0); earlier releases assemble an
 * unbounded number of fragments, so they are refused rather than run without the limit.
 */
export class ConnectorNodeRuntime {
    static readonly #lines: readonly ConnectorRuntimeLine[] = [
        { nodeMajor: 24, oldestNode: [24, 17, 0], clientMajor: 7, oldestClientMinor: 28 },
        { nodeMajor: 26, oldestNode: [26, 3, 1], clientMajor: 8, oldestClientMinor: 5 },
    ];

    /** The supported Node.js releases in words, for messages. */
    public static get supportedText(): string {
        return this.#lines
            .map(
                (line: ConnectorRuntimeLine): string =>
                    line.oldestNode.join('.') +
                    ' or newer in the ' +
                    String(line.nodeMajor) +
                    '.x line',
            )
            .join(', or ');
    }

    /** Bundled runtime APIs are checked before creating customer state or opening transport. */
    public static assertCurrent(): void {
        this.validate(process.versions.node, process.versions.undici ?? '');
    }
    /** Explicit version bounds reject unsupported Node or parser APIs without selecting another implementation. */
    public static validate(nodeVersion: string, clientVersion: string): void {
        const node: ConnectorRuntimeVersion | null = this.#parts(nodeVersion);
        const client: ConnectorRuntimeVersion | null = this.#parts(clientVersion);
        const line: ConnectorRuntimeLine | undefined = node === null ? undefined : this.#line(node);
        if (
            node === null ||
            client === null ||
            line === undefined ||
            client[0] !== line.clientMajor ||
            client[1] < line.oldestClientMinor
        ) {
            throw new ConnectorRuntimeUnsupported(
                node === null ? null : nodeVersion,
                client === null ? null : clientVersion,
            );
        }
    }
    /** Whether a well-formed Node.js version is at or above the oldest supported release of its line. */
    public static nodeSupported(nodeVersion: string): boolean {
        const node: ConnectorRuntimeVersion | null = this.#parts(nodeVersion);
        return node !== null && this.#line(node) !== undefined;
    }
    static #line(node: ConnectorRuntimeVersion): ConnectorRuntimeLine | undefined {
        return this.#lines.find(
            (line: ConnectorRuntimeLine): boolean =>
                node[0] === line.nodeMajor &&
                (node[1] > line.oldestNode[1] ||
                    (node[1] === line.oldestNode[1] && node[2] >= line.oldestNode[2])),
        );
    }
    static #parts(value: string): ConnectorRuntimeVersion | null {
        const match: RegExpExecArray | null = /^([0-9]{1,3})\.([0-9]{1,3})\.([0-9]{1,3})$/u.exec(
            value,
        );
        if (match === null) {
            return null;
        }
        return [Number(match[1]), Number(match[2]), Number(match[3])];
    }
}
