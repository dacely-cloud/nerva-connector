// SPDX-FileCopyrightText: 2026 Nerva contributors
// SPDX-License-Identifier: LicenseRef-Proprietary

import { HostShell, HostWriteMode } from './HostWorkspaceTypes.js';
import { HostHttpMethod } from './HostHttpTypes.js';
import {
    HostDesktopPointerAction,
    HostDesktopButton,
    HostDesktopKeyAction,
    HostDesktopLimits,
} from './HostDesktopTypes.js';
import type { HostJsonObject, HostMcpTool } from './HostMcpProtocol.js';
import type { HostMcpWorkspaceBounds } from './HostMcpWorkspaceBounds.js';

/** One bounded declarative catalog serves local stdio and paired host tool discovery. */
export class HostMcpWorkspaceCatalog {
    /** Return schemas with the current transport's actual chunk and directory bounds. */
    public static tools(bounds: HostMcpWorkspaceBounds): readonly HostMcpTool[] {
        const text: HostJsonObject = { type: 'string' };
        const offset: HostJsonObject = { type: 'string', pattern: '^(0|[1-9][0-9]{0,18})$' };
        const snapshot: HostJsonObject = {
            type: 'object',
            properties: {
                identity: { type: 'string', minLength: 1, maxLength: 256 },
                size: offset,
                modifiedAtNs: { type: 'string', pattern: '^(0|-?[1-9][0-9]*)$', maxLength: 40 },
            },
            required: ['identity', 'size', 'modifiedAtNs'],
            additionalProperties: false,
        };
        const bool: HostJsonObject = { type: 'boolean' };
        const maximum: HostJsonObject = {
            type: 'integer',
            minimum: 1,
            maximum: bounds.maximumChunkBytes,
        };
        const bytes: HostJsonObject = {
            data: text,
            encoding: { type: 'string', enum: ['utf8', 'base64'] },
        };
        const launch: HostJsonObject = {
            executable: text,
            arguments: { type: 'array', items: text, maxItems: 256 },
            shell: { type: 'string', enum: Object.values(HostShell) },
            command: text,
            directory: text,
            environment: { type: 'object', additionalProperties: text, maxProperties: 256 },
            timeoutMs: { type: 'integer', minimum: 1, maximum: 604800000 },
            retentionAfterTimeoutMs: {
                type: 'integer',
                minimum: 1000,
                maximum: 86400000,
                description:
                    'Optional finite output retention after the owned timeout. Reclamation follows joined cleanup; unknown cleanup remains explicit. Omit to retain until explicit release.',
            },
        };
        return [
            this.#tool(
                'network_resolve',
                'Resolve bounded addresses using this computer DNS servers. No controller DNS, URL fetch or network policy decision occurs here.',
                { hostname: { type: 'string', minLength: 1, maxLength: 253 } },
                ['hostname'],
            ),
            this.#tool(
                'http_open',
                'Open an owned HTTP input stream at an exact literal IP while preserving URL Host and TLS certificate identity. GET/HEAD only; no redirects, proxies, implicit credentials or decompression. Close the same transfer after consuming or canceling its body.',
                {
                    url: { type: 'string', minLength: 1, maxLength: 16384 },
                    address: { type: 'string', minLength: 1, maxLength: 64 },
                    method: { type: 'string', enum: Object.values(HostHttpMethod) },
                    headers: { type: 'object', additionalProperties: text, maxProperties: 8 },
                    maximumBytes: offset,
                    timeoutMs: { type: 'integer', minimum: 1000, maximum: 900000 },
                    idleTimeoutMs: { type: 'integer', minimum: 1000, maximum: 30000 },
                },
                [
                    'url',
                    'address',
                    'method',
                    'headers',
                    'maximumBytes',
                    'timeoutMs',
                    'idleTimeoutMs',
                ],
            ),
            this.#tool(
                'http_read',
                'Pull the exact next bounded body window from the same owned HTTP transfer. Pending empty data is not EOF; complete requires successful HTTP framing. Failed bodies remain failed. An unknown read outcome requires exact-original recovery rather than a new cursor guess.',
                { transferId: text, offset, maximumBytes: maximum },
                ['transferId', 'offset', 'maximumBytes'],
            ),
            this.#tool(
                'http_close',
                'Cancel and join the original HTTP request and socket. A failed close retains native ownership; it never opens another transfer.',
                { transferId: text },
                ['transferId'],
            ),
            this.#tool(
                'environment_inspect',
                'Report whether bare program names resolve on this computer connector runtime PATH and whether environment variables are set to non-empty values. Native read-only filesystem checks only: no subprocess, shell, PowerShell, Python or registry, and the current directory is never searched. Windows applies PATHEXT. Returns platform plus boolean arrays aligned with request order; resolved paths and variable values are never returned. Names must be unique; programs cannot be . or .. or contain / or \\.',
                {
                    programs: {
                        type: 'array',
                        items: {
                            type: 'string',
                            minLength: 1,
                            maxLength: 255,
                            pattern: '^[^/\\\\\\u0000]+$',
                        },
                        maxItems: 256,
                        uniqueItems: true,
                    },
                    variables: {
                        type: 'array',
                        items: {
                            type: 'string',
                            minLength: 1,
                            maxLength: 255,
                            pattern: '^[^=\\u0000]+$',
                        },
                        maxItems: 256,
                        uniqueItems: true,
                    },
                },
                ['programs', 'variables'],
            ),
            this.#tool(
                'file_publish',
                'Atomically publish a regular source file without replacing an existing destination, using a same-filesystem hard link then source cleanup. Cleanup failure may leave both paths and must not trigger a fresh automatic publish.',
                { source: text, destination: text },
                ['source', 'destination'],
            ),
            this.#tool(
                'file_rename',
                'Atomically rename a file or directory using the host filesystem replacement semantics. Cross-filesystem moves fail without a copy/delete fallback.',
                { source: text, destination: text },
                ['source', 'destination'],
            ),
            this.#tool(
                'file_chmod',
                'Set exact POSIX permission bits on supported hosts. Windows rejects this operation because POSIX mode bits do not implement Windows DACLs.',
                { path: text, mode: { type: 'integer', minimum: 0, maximum: 4095 } },
                ['path', 'mode'],
            ),
            this.#tool(
                'desktop_info',
                'Inspect interactive desktop availability, scope, physical geometry and missing prerequisites without opening a consent dialog. Wayland reports selected-monitor scope; consent-required means the first actual desktop operation asks the local user to choose a monitor and approve control.',
                {},
                [],
            ),
            this.#tool(
                'desktop_screenshot',
                'Capture the reported desktop scope to an explicitly selected PNG file. Wayland captures only the monitor approved in the system chooser. Returns physical source geometry, scaled image dimensions and exact file size; read that intentional file through file_read byte chunks.',
                {
                    path: text,
                    mode: { type: 'string', enum: ['create', 'replace'] },
                    maximumWidth: {
                        type: 'integer',
                        minimum: 1,
                        maximum: HostDesktopLimits.dimension,
                    },
                    maximumHeight: {
                        type: 'integer',
                        minimum: 1,
                        maximum: HostDesktopLimits.dimension,
                    },
                },
                ['path', 'mode'],
            ),
            this.#tool(
                'application_open',
                'Windows: open an installed application and return its launch receipt and screen. For registered Chrome, Firefox or Edge, an optional HTTP(S) URL opens directly in that browser without global keyboard input. Ambiguous or missing names never launch. A visible browser window does not prove the web page loaded.',
                {
                    name: { type: 'string', minLength: 1, maxLength: 4096 },
                    url: { type: 'string', minLength: 8, maxLength: 4096 },
                },
                ['name'],
            ),
            this.#tool(
                'desktop_snapshot',
                'Windows: capture the current desktop once and return its bounded image inline, without creating a file or selecting a workspace.',
                {},
                [],
            ),
            this.#tool(
                'desktop_pointer',
                'Move the real mouse, click, press or release a button in the approved desktop scope. For a screenshot pixel position, supply its width, height and source geometry in image; the connector maps it to physical pixels and rejects a changed desktop. Without image, x/y use desktop_info physical pixels. Click an input to focus it before desktop_text. Wayland covers only the selected monitor.',
                {
                    x: { type: 'integer', minimum: -1000000, maximum: 1000000 },
                    y: { type: 'integer', minimum: -1000000, maximum: 1000000 },
                    action: { type: 'string', enum: Object.values(HostDesktopPointerAction) },
                    button: {
                        type: ['string', 'null'],
                        enum: [null, ...Object.values(HostDesktopButton)],
                    },
                    image: {
                        type: 'object',
                        additionalProperties: false,
                        properties: {
                            width: {
                                type: 'integer',
                                minimum: 1,
                                maximum: HostDesktopLimits.dimension,
                            },
                            height: {
                                type: 'integer',
                                minimum: 1,
                                maximum: HostDesktopLimits.dimension,
                            },
                            sourceX: { type: 'integer', minimum: -65535, maximum: 65535 },
                            sourceY: { type: 'integer', minimum: -65535, maximum: 65535 },
                            sourceWidth: { type: 'integer', minimum: 1, maximum: 65535 },
                            sourceHeight: { type: 'integer', minimum: 1, maximum: 65535 },
                        },
                        required: [
                            'width',
                            'height',
                            'sourceX',
                            'sourceY',
                            'sourceWidth',
                            'sourceHeight',
                        ],
                    },
                },
                ['x', 'y', 'action'],
            ),
            this.#tool(
                'desktop_key',
                'Press a key or atomic Windows chord such as Control+l, or hold/release a single key. Windows fresh input requires target from the intended windowTarget returned by a snapshot or verified application launch. Release held inputs after use.',
                {
                    key: text,
                    action: { type: 'string', enum: Object.values(HostDesktopKeyAction) },
                    target: { type: 'string', maxLength: 60 },
                },
                ['key', 'action'],
            ),
            this.#tool(
                'desktop_text',
                'Windows requires a windowTarget as target. Exact accessibility field name or ID plus replace:true replaces one unique standard Windows Edit control and verifies the value without focusing the app. Unsupported controls fail with no typing fallback. Without field, text is guarded foreground input.',
                { text, target: { type: 'string', maxLength: 60 }, field: { type: 'string', maxLength: 256 }, replace: { type: 'boolean', enum: [true] } },
                ['text'],
            ),
            this.#tool(
                'computer_info',
                'Read this computer OS, CPU, memory and GPU specifications.',
                {},
                [],
            ),
            this.#tool(
                'file_read',
                'Read a bounded file chunk. Exact decimal byte offsets allow complete reads of large files. Optional snapshot identity/size/modifiedAtNs are validated on the same opened descriptor before and after this read.',
                { path: text, offset, maximumBytes: maximum, snapshot },
                ['path'],
            ),
            this.#tool(
                'file_digest',
                'Compute complete SHA-256 by streaming the same opened file descriptor, checking required snapshot identity/size/modifiedAtNs before and after all bytes. A deadline or generation change fails without returning a partial-file hash.',
                { path: text, snapshot },
                ['path', 'snapshot'],
            ),
            this.#tool(
                'file_write',
                'Write file bytes. create refuses replacement; replace truncates; update writes at offset; append preserves existing data.',
                {
                    path: text,
                    ...bytes,
                    mode: { type: 'string', enum: Object.values(HostWriteMode) },
                    offset,
                },
                ['path', 'data', 'encoding', 'mode'],
            ),
            this.#tool(
                'file_stat',
                'Read exact metadata for a host path. follow:true observes a symlink target; default false reports the link itself.',
                { path: text, follow: bool },
                ['path'],
            ),
            this.#tool(
                'directory_list',
                'List a page of directory entries; continue using nextOffset until null.',
                {
                    path: text,
                    offset: { type: 'integer', minimum: 0, maximum: 1000000 },
                    maximumEntries: {
                        type: 'integer',
                        minimum: 1,
                        maximum: bounds.maximumDirectoryEntries,
                    },
                },
                ['path'],
            ),
            this.#tool(
                'directory_create',
                'Create a directory, optionally including missing parents.',
                { path: text, recursive: bool },
                ['path', 'recursive'],
            ),
            this.#tool(
                'file_remove',
                'Remove a host file or directory. Recursive removal must be explicit.',
                { path: text, recursive: bool },
                ['path', 'recursive'],
            ),
            this.#tool(
                'process_start',
                'Start any installed program (including an MCP server or desktop application) or a selected shell command. Choose executable with arguments, or shell with command. Returns an owned process ID; read output, send stdin and stop/release that same process. OS user permissions and installed programs apply.',
                launch,
                ['timeoutMs'],
            ),
            this.#tool(
                'process_read',
                'Read the same owned process and bounded stdout/stderr chunks. Continue from returned nextOffset values; truncated means older bytes are unavailable.',
                {
                    processId: text,
                    stdoutOffset: offset,
                    stderrOffset: offset,
                    maximumBytes: maximum,
                },
                ['processId'],
            ),
            this.#tool(
                'process_write',
                'Send exact bytes to an owned process stdin, including newline-delimited MCP requests. end explicitly closes stdin.',
                { processId: text, ...bytes, end: bool },
                ['processId', 'data', 'encoding', 'end'],
            ),
            this.#tool(
                'process_stop',
                'Stop the owned process tree and join its lifecycle. Effects already performed remain.',
                { processId: text },
                ['processId'],
            ),
            this.#tool(
                'process_release',
                'Stop and release an owned process and its retained output. Effects already performed remain.',
                { processId: text },
                ['processId'],
            ),
            this.#tool(
                'terminal_start',
                'Start a real native terminal for an installed program or selected shell. Output is one merged terminal byte stream; this is distinct from an MCP stdio pipe. Choose executable/arguments or shell/command. OS user permissions apply; no sandbox or managed native-lock capability is supplied.',
                {
                    ...launch,
                    cols: { type: 'integer', minimum: 2, maximum: 500 },
                    rows: { type: 'integer', minimum: 1, maximum: 200 },
                },
                ['timeoutMs', 'cols', 'rows'],
            ),
            this.#tool(
                'terminal_read',
                'Read the same owned terminal and its merged output. Continue from output.nextOffset; truncated explicitly identifies unavailable earlier bytes. running describes the root program; treeRunning is independent and can be unknown. finalOutputBytes and outputComplete describe received native terminal bytes.',
                { processId: text, offset, maximumBytes: maximum },
                ['processId'],
            ),
            this.#tool(
                'terminal_write',
                'Write exact bytes to the same owned terminal input. Ctrl-D is data with terminal semantics; this operation never turns it into pipe EOF. An unknown write outcome must not be retried as a fresh original.',
                { processId: text, ...bytes },
                ['processId', 'data', 'encoding'],
            ),
            this.#tool(
                'terminal_resize',
                'Resize the actual native terminal without injecting commands.',
                {
                    processId: text,
                    cols: { type: 'integer', minimum: 2, maximum: 500 },
                    rows: { type: 'integer', minimum: 1, maximum: 200 },
                },
                ['processId', 'cols', 'rows'],
            ),
            this.#tool(
                'terminal_stop',
                'Stop and join the owned terminal lifecycle while retaining its output. Unknown shutdown is not reported as successful quiescence.',
                { processId: text },
                ['processId'],
            ),
            this.#tool(
                'terminal_release',
                'Stop and release the owned terminal and its retained output. This does not undo effects already performed.',
                { processId: text },
                ['processId'],
            ),
        ];
    }

    static #tool(
        name: string,
        description: string,
        properties: HostJsonObject,
        required: readonly string[],
    ): HostMcpTool {
        return {
            name,
            description,
            inputSchema: { type: 'object', properties, required, additionalProperties: false },
        };
    }
}
