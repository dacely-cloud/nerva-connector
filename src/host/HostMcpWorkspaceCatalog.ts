// SPDX-FileCopyrightText: 2026 Dacely <business@dacely.com>
// SPDX-License-Identifier: LicenseRef-Proprietary

import { ConnectorHostTool } from 'nerva-connector-protocol/protocol/ConnectorHost.js';
import type { ConnectorHostArgumentBounds } from 'nerva-connector-protocol/protocol/ConnectorHostArgumentContract.js';
import { ConnectorHostArgumentSchema } from 'nerva-connector-protocol/protocol/ConnectorHostArgumentSchema.js';
import type { HostMcpTool } from './HostMcpProtocol.js';
import type { HostMcpWorkspaceBounds } from './HostMcpWorkspaceBounds.js';

/**
 * One bounded declarative catalog serves local stdio and paired host tool discovery.
 *
 * @remarks
 * Input schemas are rendered from the argument contracts in nerva-connector-protocol, the same contracts the tool
 * parser enforces and remote clients check before submitting; only the descriptions belong to this catalog.
 */
export class HostMcpWorkspaceCatalog {
    static readonly #descriptions: readonly (readonly [ConnectorHostTool, string])[] = [
        [
            ConnectorHostTool.NetworkResolve,
            'Resolve bounded addresses using this computer DNS servers. No controller DNS, URL fetch or network policy decision occurs here.',
        ],
        [
            ConnectorHostTool.HttpOpen,
            'Open an owned HTTP input stream at an exact literal IP while preserving URL Host and TLS certificate identity. GET/HEAD only; no redirects, proxies, implicit credentials or decompression. Close the same transfer after consuming or canceling its body.',
        ],
        [
            ConnectorHostTool.HttpRead,
            'Pull the exact next bounded body window from the same owned HTTP transfer. Pending empty data is not EOF; complete requires successful HTTP framing. Failed bodies remain failed. An unknown read outcome requires exact-original recovery rather than a new cursor guess.',
        ],
        [
            ConnectorHostTool.HttpClose,
            'Cancel and join the original HTTP request and socket. A failed close retains native ownership; it never opens another transfer.',
        ],
        [
            ConnectorHostTool.EnvironmentInspect,
            'Report whether bare program names resolve on this computer connector runtime PATH and whether environment variables are set to non-empty values. Native read-only filesystem checks only: no subprocess, shell, PowerShell, Python or registry, and the current directory is never searched. Windows applies PATHEXT. Returns platform plus boolean arrays aligned with request order; resolved paths and variable values are never returned. Names must be unique; programs cannot be . or .. or contain / or \\.',
        ],
        [
            ConnectorHostTool.FilePublish,
            'Atomically publish a regular source file without replacing an existing destination, using a same-filesystem hard link then source cleanup. Cleanup failure may leave both paths and must not trigger a fresh automatic publish.',
        ],
        [
            ConnectorHostTool.FileRename,
            'Atomically rename a file or directory using the host filesystem replacement semantics. Cross-filesystem moves fail without a copy/delete fallback.',
        ],
        [
            ConnectorHostTool.FileChmod,
            'Set exact POSIX permission bits on supported hosts. Windows rejects this operation because POSIX mode bits do not implement Windows DACLs.',
        ],
        [
            ConnectorHostTool.DesktopInfo,
            'Inspect interactive desktop availability, scope, physical geometry and missing prerequisites without opening a consent dialog. Wayland reports selected-monitor scope; consent-required means the first actual desktop operation asks the local user to choose a monitor and approve control.',
        ],
        [
            ConnectorHostTool.DesktopScreenshot,
            'Capture the reported desktop scope to an explicitly selected PNG file. Wayland captures only the monitor approved in the system chooser. Returns physical source geometry, scaled image dimensions and exact file size; read that intentional file through file_read byte chunks.',
        ],
        [
            ConnectorHostTool.ApplicationOpen,
            'Windows: open an installed application and return its launch receipt and screen. For registered Chrome, Firefox or Edge, pass an HTTP(S) url or a workspaceFile pointing to an HTML file inside the selected workspace. Ambiguous or missing names never launch. A visible browser window does not prove the page loaded.',
        ],
        [
            ConnectorHostTool.DesktopSnapshot,
            'Windows and Linux X11: capture the current desktop once and return its bounded image inline, without creating a file or selecting a workspace.',
        ],
        [
            ConnectorHostTool.DesktopPointer,
            'Move the real mouse, click, press or release a button in the approved desktop scope. For a screenshot pixel position, supply its width, height and source geometry in image; the connector maps it to physical pixels and rejects a changed desktop. Without image, x/y use desktop_info physical pixels. Click an input to focus it before desktop_text. Wayland covers only the selected monitor.',
        ],
        [
            ConnectorHostTool.DesktopKey,
            'Press a key or atomic Windows chord such as Control+l, or hold/release a single key. Windows fresh input requires target from the intended windowTarget returned by a snapshot or verified application launch. Release held inputs after use.',
        ],
        [
            ConnectorHostTool.DesktopText,
            'Windows requires a windowTarget as target. Exact accessibility field name or ID plus replace:true replaces one unique standard Windows Edit control and verifies the value without focusing the app. Unsupported controls fail with no typing fallback. Without field, text is guarded foreground input.',
        ],
        [
            ConnectorHostTool.ComputerInfo,
            'Read this computer OS, CPU, memory and GPU specifications.',
        ],
        [
            ConnectorHostTool.FileRead,
            'Read a bounded file chunk. Exact decimal byte offsets allow complete reads of large files. Optional snapshot identity/size/modifiedAtNs are validated on the same opened descriptor before and after this read.',
        ],
        [
            ConnectorHostTool.FileDigest,
            'Compute complete SHA-256 by streaming the same opened file descriptor, checking required snapshot identity/size/modifiedAtNs before and after all bytes. A deadline or generation change fails without returning a partial-file hash.',
        ],
        [
            ConnectorHostTool.FileWrite,
            'Write file bytes. create refuses replacement; replace truncates; update writes at offset; append preserves existing data.',
        ],
        [
            ConnectorHostTool.FileStat,
            'Read exact metadata for a host path. follow:true observes a symlink target; default false reports the link itself.',
        ],
        [
            ConnectorHostTool.DirectoryList,
            'List a page of directory entries; continue using nextOffset until null.',
        ],
        [
            ConnectorHostTool.DirectoryCreate,
            'Create a directory, optionally including missing parents.',
        ],
        [
            ConnectorHostTool.FileRemove,
            'Remove a host file or directory. Recursive removal must be explicit.',
        ],
        [
            ConnectorHostTool.ProcessStart,
            'Start any installed program (including an MCP server or desktop application) or a selected shell command. Choose executable with arguments, or shell with command. Returns an owned process ID; read output, send stdin and stop/release that same process. OS user permissions and installed programs apply.',
        ],
        [
            ConnectorHostTool.ProcessRead,
            'Read the same owned process and bounded stdout/stderr chunks. Continue from returned nextOffset values; truncated means older bytes are unavailable.',
        ],
        [
            ConnectorHostTool.ProcessWrite,
            'Send exact bytes to an owned process stdin, including newline-delimited MCP requests. end explicitly closes stdin.',
        ],
        [
            ConnectorHostTool.ProcessStop,
            'Stop the owned process tree and join its lifecycle. Effects already performed remain.',
        ],
        [
            ConnectorHostTool.ProcessRelease,
            'Stop and release an owned process and its retained output. Effects already performed remain.',
        ],
        [
            ConnectorHostTool.TerminalStart,
            'Start a real native terminal for an installed program or selected shell. Output is one merged terminal byte stream; this is distinct from an MCP stdio pipe. Choose executable/arguments or shell/command. OS user permissions apply; no sandbox or managed native-lock capability is supplied.',
        ],
        [
            ConnectorHostTool.TerminalRead,
            'Read the same owned terminal and its merged output. Continue from output.nextOffset; truncated explicitly identifies unavailable earlier bytes. running describes the root program; treeRunning is independent and can be unknown. finalOutputBytes and outputComplete describe received native terminal bytes.',
        ],
        [
            ConnectorHostTool.TerminalWrite,
            'Write exact bytes to the same owned terminal input. Ctrl-D is data with terminal semantics; this operation never turns it into pipe EOF. An unknown write outcome must not be retried as a fresh original.',
        ],
        [
            ConnectorHostTool.TerminalResize,
            'Resize the actual native terminal without injecting commands.',
        ],
        [
            ConnectorHostTool.TerminalStop,
            'Stop and join the owned terminal lifecycle while retaining its output. Unknown shutdown is not reported as successful quiescence.',
        ],
        [
            ConnectorHostTool.TerminalRelease,
            'Stop and release the owned terminal and its retained output. This does not undo effects already performed.',
        ],
    ];
    static readonly #fieldDescriptions: Readonly<Record<string, string>> = {
        retentionAfterTimeoutMs:
            'Optional finite output retention after the owned timeout. Reclamation follows joined cleanup; unknown cleanup remains explicit. Omit to retain until explicit release.',
    };

    /** Return schemas with the current transport's actual chunk and directory bounds. */
    public static tools(bounds: HostMcpWorkspaceBounds): readonly HostMcpTool[] {
        const argumentBounds: ConnectorHostArgumentBounds = this.argumentBounds(bounds);
        return this.#descriptions.map(
            ([name, description]: readonly [ConnectorHostTool, string]): HostMcpTool => ({
                name,
                description,
                inputSchema: ConnectorHostArgumentSchema.of(
                    name,
                    argumentBounds,
                    this.#fieldDescriptions,
                ),
            }),
        );
    }

    /** The argument contract bounds of a transport: its chunk size and directory page size. */
    public static argumentBounds(bounds: HostMcpWorkspaceBounds): ConnectorHostArgumentBounds {
        return {
            chunkBytes: bounds.maximumChunkBytes,
            directoryEntries: bounds.maximumDirectoryEntries,
        };
    }
}
