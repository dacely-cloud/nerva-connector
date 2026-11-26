// SPDX-FileCopyrightText: 2026 Dacely <business@dacely.com>
// SPDX-License-Identifier: LicenseRef-Proprietary

/** Fixed HTTPS release directories cannot redirect a bootstrap into another trust source. */
export class ConnectorReleaseDownload {
    /** Credentials, queries, fragments and ambiguous non-directory bases are refused before output generation. */
    public static directory(baseUrl: string): URL {
        const url: URL = new URL(baseUrl);
        if (
            Buffer.byteLength(baseUrl) > 4096 ||
            url.protocol !== 'https:' ||
            url.username !== '' ||
            url.password !== '' ||
            url.search !== '' ||
            url.hash !== '' ||
            !url.pathname.endsWith('/')
        ) {
            throw new Error('Connector release download requires its trusted HTTPS directory');
        }
        return url;
    }
}
