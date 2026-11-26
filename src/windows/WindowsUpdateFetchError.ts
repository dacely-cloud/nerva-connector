// SPDX-FileCopyrightText: 2026 Dacely <business@dacely.com>
// SPDX-License-Identifier: LicenseRef-Proprietary

/** Only bounded error codes cross the updater pipe; URLs, local paths and server messages never enter its log. */
export class WindowsUpdateFetchError extends Error {
    /** A finite diagnostic code contains no original exception message or request data. */
    public readonly code: string;

    /** The code is a closed-format diagnostic, never untrusted exception text. */
    public constructor(code: string) {
        const checked: string = WindowsUpdateFetchError.#code(code);
        super('windows-update-fetch code=' + checked);
        this.code = checked;
        this.name = 'WindowsUpdateFetchError';
    }

    /** Node's TLS, certificate, network and filesystem codes remain useful without exposing their messages. */
    public static from(caught: unknown): WindowsUpdateFetchError {
        if (caught instanceof WindowsUpdateFetchError) {
            return caught;
        }
        const descriptor: PropertyDescriptor | undefined =
            caught !== null && typeof caught === 'object'
                ? Object.getOwnPropertyDescriptor(caught, 'code')
                : undefined;
        const code: unknown = descriptor?.value;
        return new WindowsUpdateFetchError(typeof code === 'string' ? code : 'FAILED');
    }

    static #code(code: string): string {
        return /^[A-Z0-9_]{1,64}$/u.test(code) ? code : 'FAILED';
    }
}
