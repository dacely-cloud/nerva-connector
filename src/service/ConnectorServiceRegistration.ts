// SPDX-FileCopyrightText: 2026 Nerva contributors
// SPDX-License-Identifier: LicenseRef-Proprietary

import { Boundary } from 'nerva-connector-protocol/protocol/Boundary.js';
import {
    ConnectorServicePhase,
    type ConnectorServiceRecord,
    type ConnectorServiceLayout,
} from './ConnectorServiceTypes.js';

/** Atomic registration reads bind startup and administrative operations to one current exact unit. */
export class ConnectorServiceRegistration {
    /** Unknown/incomplete state is rejected rather than adopted as current local authority. */
    public static read(bytes: Buffer, layout: ConnectorServiceLayout): ConnectorServiceRecord {
        const value: Readonly<Record<string, unknown>> = Boundary.record(
            JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes)),
            ['scope', 'unitName', 'sha256', 'phase'],
        );
        const phase: ConnectorServicePhase | undefined = Object.values(ConnectorServicePhase).find(
            (entry): boolean => entry === value['phase'],
        );
        if (
            phase === undefined ||
            value['scope'] !== layout.scope ||
            value['unitName'] !== layout.unitName ||
            value['sha256'] !== layout.sha256
        ) {
            throw new Error('Service registration differs from its original unit');
        }
        return { phase, scope: layout.scope, unitName: layout.unitName, sha256: layout.sha256 };
    }
}
