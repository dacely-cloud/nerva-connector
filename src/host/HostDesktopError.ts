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
        'key-release',
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
        'keyboard-target-required',
        'keyboard-target-invalid',
        'keyboard-target-stale',
        'keyboard-target-unavailable',
        'keyboard-focus-denied',
        'keyboard-modifiers-active',
        'keyboard-key-active',
        'keyboard-owned-input-changed',
        'keyboard-text-invalid',
        'keyboard-input-rejected',
        'keyboard-input-partial',
        'keyboard-release-unconfirmed',
        'keyboard-field-invalid',
        'keyboard-field-unsupported',
        'keyboard-field-not-found',
        'keyboard-field-ambiguous',
        'keyboard-field-read-only',
        'keyboard-field-unavailable',
        'keyboard-field-search-limit',
        'keyboard-field-write-unconfirmed',
        'key-chord',
        'desktop-unavailable',
        'application-name',
        'application-browser-url',
        'application-browser-name',
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
    /** Validation and native rejections that occur before input prove a definite failure. */
    public readonly definitive: boolean;

    /** Only a fixed native diagnostic record is accepted; arbitrary stderr never enters logs or UI. */
    public constructor(
        public readonly operation: string,
        public readonly reason: string,
        public readonly nativeCode: number | null,
    ) {
        super(HostDesktopError.message(reason));
        this.name = 'HostDesktopError';
        this.code =
            nativeCode === 5 || nativeCode === 2147942405 || reason === 'keyboard-focus-denied' || reason === 'keyboard-field-read-only'
                ? 'EACCES'
                : reason === 'keyboard-field-unsupported' ? 'ENOTSUP'
                : reason === 'keyboard-field-not-found' ? 'ENOENT'
                : reason === 'keyboard-field-search-limit' ? 'E2BIG'
                : [
                        'screenshot-geometry-changed',
                        'screenshot-geometry-invalid',
                        'pointer-outside-image',
                        'keyboard-target-required',
                        'keyboard-target-invalid',
                        'keyboard-owned-input-changed',
                        'keyboard-text-invalid',
                        'key-chord',
                        'key',
                        'key-action',
                        'application-name',
                        'application-browser-url',
                        'application-browser-name',
                        'keyboard-field-invalid',
                        'keyboard-field-ambiguous',
                    ].includes(reason)
                  ? 'EINVAL'
                  : 'EIO';
        this.definitive = [
            'screenshot-geometry-changed',
            'screenshot-geometry-invalid',
            'pointer-outside-image',
            'keyboard-target-required',
            'keyboard-target-invalid',
            'keyboard-target-stale',
            'keyboard-target-unavailable',
            'keyboard-focus-denied',
            'keyboard-focus-unavailable',
            'keyboard-modifiers-active',
            'keyboard-key-active',
            'keyboard-owned-input-changed',
            'keyboard-text-invalid',
            'keyboard-input-rejected',
            'key-chord',
            'key',
            'key-action',
            'desktop-unavailable',
            'application-name',
            'application-browser-url',
            'application-browser-name',
            'keyboard-field-invalid',
            'keyboard-field-unsupported',
            'keyboard-field-not-found',
            'keyboard-field-ambiguous',
            'keyboard-field-read-only',
            'keyboard-field-unavailable',
            'keyboard-field-search-limit',
        ].includes(reason);
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
                return 'Keyboard focus changed around input delivery. Some input may have been delivered; inspect a fresh snapshot before continuing. The original action was not retried.';
            case 'keyboard-focus-unavailable':
                return 'No foreground window is available for typing. Focus the intended application first.';
            case 'keyboard-target-required':
                return 'Windows input needs the intended windowTarget from a fresh snapshot or verified application launch. No input was sent.';
            case 'keyboard-target-invalid':
                return 'The Windows window target is invalid. No input was sent.';
            case 'keyboard-target-stale':
                return 'The observed window closed or its process changed. Take a fresh snapshot; no input was sent.';
            case 'keyboard-target-unavailable':
                return 'Windows could not verify or use the intended application window. No input was sent.';
            case 'keyboard-focus-denied':
                return 'Windows denied focus to the intended application. No input was sent to another window.';
            case 'keyboard-modifiers-active':
            case 'keyboard-key-active':
                return 'A conflicting key or modifier is already held. Release it before typing; no input was sent.';
            case 'keyboard-owned-input-changed':
                return 'The held-key state no longer matches this desktop session. No new input was sent.';
            case 'keyboard-text-invalid':
                return 'Desktop text must be bounded valid Unicode without null characters. No input was sent.';
            case 'key-chord':
                return 'Use one key, or press a chord of distinct Control, Alt, Shift or Meta modifiers followed by one key. No input was sent.';
            case 'keyboard-input-rejected':
                return 'Windows rejected the entire keyboard input batch. No input was inserted.';
            case 'keyboard-input-partial':
                return 'Windows accepted only part of the keyboard input; owned held keys were released where possible. The operation was not retried.';
            case 'keyboard-release-unconfirmed':
                return 'Windows could not confirm release of an injected key. Stop input and release held keys manually before continuing.';
            case 'keyboard-field-invalid':
                return 'App-scoped text needs one exact field name or automation ID and replace:true. No text was changed.';
            case 'keyboard-field-unsupported':
                return 'Background replacement requires a verified standard Windows Edit control. No focus or keyboard fallback was used.';
            case 'keyboard-field-not-found':
                return 'No editable field exactly matched the requested name or automation ID in the selected application.';
            case 'keyboard-field-ambiguous':
                return 'More than one editable field matched. Choose a unique exact name or automation ID; no text was changed.';
            case 'keyboard-field-read-only':
                return 'The matching accessibility field is disabled or read-only. No text was changed.';
            case 'keyboard-field-search-limit':
                return 'Accessibility discovery exceeded its bounded tree or time limit. No text was changed.';
            case 'keyboard-field-unavailable':
                return 'The accessibility field or its verified application identity changed before replacement. No text was changed.';
            case 'keyboard-field-write-unconfirmed':
                return 'The application value replacement could not be verified. It may have changed; the original operation was not retried.';
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
            case 'application-name':
                return 'Provide the installed application name.';
            case 'application-browser-url':
                return 'Provide one HTTP or HTTPS address without credentials.';
            case 'application-browser-name':
                return 'A web address can be opened in Chrome, Firefox or Edge.';
            case 'application-catalog-limit':
                return 'Installed application discovery exceeded its bounded catalog size.';
            default:
                return 'The native desktop operation failed. Its operation, reason and native code are recorded in /log.';
        }
    }
}
