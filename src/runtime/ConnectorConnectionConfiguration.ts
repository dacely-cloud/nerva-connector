// SPDX-FileCopyrightText: 2026 Nerva contributors
// SPDX-License-Identifier: LicenseRef-Proprietary

import { Boundary } from 'nerva-connector-protocol/protocol/Boundary.js';
import { ConnectorTransportLimits } from '../protocol/ConnectorTransport.js';
import { ProtectedFiles } from '../local/ProtectedFiles.js';
import type { ConnectorLocalCapabilitySettings } from './ConnectorClientSettings.js';

/** Pairing and enrolled transports share the exact same endpoint and explicit local capability validation. */
export class ConnectorConnectionConfiguration {
    /** No URL carries a secret, account selector, query, fragment or plaintext fallback. */
    public static endpoints(raw: unknown): readonly string[] {
        const endpoints: readonly string[] = Boundary.array(raw, 8).map(
            (entry: unknown): string => {
                const url: URL = new URL(Boundary.text(entry));
                if (
                    url.protocol !== 'wss:' ||
                    url.username !== '' ||
                    url.password !== '' ||
                    url.pathname !== ConnectorTransportLimits.path ||
                    url.search !== '' ||
                    url.hash !== ''
                ) {
                    throw new Error('Connector endpoints require TLS and the exact current path');
                }
                return url.href;
            },
        );
        if (endpoints.length === 0 || new Set(endpoints).size !== endpoints.length) {
            throw new Error('A bounded unique connector edge set is required');
        }
        return Object.freeze(endpoints);
    }
    /** Each optional capability names its local grants and retained journal; the runtime owns the one deployment public-key pin. */
    public static capability(raw: unknown): ConnectorLocalCapabilitySettings | null {
        if (raw === null) {
            return null;
        }
        const value: Readonly<Record<string, unknown>> = Boundary.record(raw, [
            'policyFile',
            'stateDirectory',
        ]);
        return Object.freeze({
            policyFile: ProtectedFiles.path(value['policyFile']),
            stateDirectory: ProtectedFiles.path(value['stateDirectory']),
        });
    }
}
