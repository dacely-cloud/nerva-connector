// SPDX-FileCopyrightText: 2026 Nerva contributors
// SPDX-License-Identifier: LicenseRef-Proprietary

/** Native desktop failures retain fixed diagnostic fields without commands, typed text or image data. */
export class HostDesktopError extends Error {
    static readonly #operations: ReadonlySet<string> = new Set([
        'info',
        'application-open',
        'snapshot',
        'screenshot',
        'pointer',
        'button-up',
        'key',
        'text',
    ]);
    static readonly #reasons: ReadonlySet<string> = new Set([
        'screenshot-geometry-changed',
        'screenshot-geometry-invalid',
        'pointer-outside-image',
        'input-not-delivered',
        'pointer-move-rejected',
        'pointer-position-unconfirmed',
        'keyboard-focus-unavailable',
        'keyboard-focus-changed',
        'desktop-unavailable',
        'application-launch-rejected',
        'application-catalog-limit',
        'desktop-fields',
        'desktop-input-limit',
        'desktop-operation',
        'source-pixels',
        'inline-image-limit',
        'image-limit',
        'image-codec-unavailable',
        'source-geometry',
        'key',
        'key-action',
        'button',
    ]);
    /** A native access denial remains distinct from an unclassified OS failure. */
    public readonly code: string;

    /** Only a fixed native diagnostic record is accepted; arbitrary stderr never enters logs or UI. */
    public constructor(
        public readonly operation: string,
        public readonly reason: string,
        public readonly nativeCode: number | null,
    ) {
        super(HostDesktopError.message(reason));
        this.name = 'HostDesktopError';
        this.code =
            nativeCode === 5
                ? 'EACCES'
                : [
                        'screenshot-geometry-changed',
                        'screenshot-geometry-invalid',
                        'pointer-outside-image',
                    ].includes(reason)
                  ? 'EINVAL'
                  : 'EIO';
    }

    /** Missing/truncated native reports still yield a bounded actionable error. */
    public static read(stderr: Buffer, timeout: boolean): HostDesktopError {
        const text: string = stderr.subarray(0, 8192).toString('utf8');
        const match: RegExpMatchArray | null = text.match(
            /^NERVA_DESKTOP operation=([a-z-]{1,32}) reason=([a-z-]{1,64}) native=([0-9]{1,10})$/mu,
        );
        if (match === null) {
            return new HostDesktopError('unknown', timeout ? 'timeout' : 'operation-failed', null);
        }
        const code: number = Number(match[3]);
        return new HostDesktopError(
            this.#operations.has(match[1]) ? match[1] : 'unknown',
            this.#reasons.has(match[2]) ? match[2] : 'operation-failed',
            Number.isSafeInteger(code) && code <= 4294967295 ? code : null,
        );
    }

    /** Native reason identifiers map to product language and never echo the request payload. */
    public static message(reason: string): string {
        switch (reason) {
            case 'screenshot-geometry-changed':
                return 'Screenshot geometry changed; take a fresh screenshot before clicking.';
            case 'screenshot-geometry-invalid':
                return 'Screenshot geometry must include valid image dimensions and physical source coordinates.';
            case 'pointer-outside-image':
                return 'The requested mouse position is outside the screenshot image.';
            case 'input-not-delivered':
                return 'Windows rejected mouse or keyboard input. Check the focused window, secure desktop, or an administrator-only application.';
            case 'pointer-move-rejected':
                return 'Windows rejected movement of the real mouse pointer.';
            case 'pointer-position-unconfirmed':
                return 'The mouse did not reach the requested desktop position.';
            case 'keyboard-focus-changed':
                return 'Keyboard focus changed while typing; input was stopped to avoid typing into another window.';
            case 'keyboard-focus-unavailable':
                return 'No foreground window is available for typing. Focus the intended application first.';
            case 'desktop-unavailable':
                return 'The interactive Windows desktop is unavailable or locked.';
            case 'source-pixels':
                return 'The desktop exceeds the capture limit of 16,777,216 source pixels.';
            case 'image-limit':
            case 'inline-image-limit':
                return 'The captured image exceeds its bounded output size.';
            case 'image-codec-unavailable':
                return 'The Windows JPEG encoder is unavailable.';
            case 'source-geometry':
                return 'The captured screen does not match its reported physical geometry.';
            case 'timeout':
                return 'The desktop operation timed out; it may have had a partial effect.';
            case 'application-launch-rejected':
                return 'Windows rejected the installed application launch.';
            case 'application-catalog-limit':
                return 'Installed application discovery exceeded its bounded catalog size.';
            default:
                return 'The native desktop operation failed. Its operation, reason and native code are recorded in /log.';
        }
    }
}
