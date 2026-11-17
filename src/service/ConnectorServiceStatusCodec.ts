// SPDX-FileCopyrightText: 2026 Nerva contributors
// SPDX-License-Identifier: LicenseRef-Proprietary

import { Boundary } from 'nerva-connector-protocol/protocol/Boundary.js';
import {
    ConnectorServiceScope,
    ConnectorServiceActiveState,
    ConnectorServiceEnabledState,
    ConnectorServiceLoadState,
    type ConnectorServiceStatus,
} from './ConnectorServiceTypes.js';

/** Automation validates serialized local service observations without accepting authority from a supplied PID or unit name. */
export class ConnectorServiceStatusCodec {
    /** Unknown fields, unsupported states and inexact counters cannot become a valid observation. */
    public static read(raw: unknown): ConnectorServiceStatus {
        const value: Readonly<Record<string, unknown>> = Boundary.record(raw, [
            'scope',
            'unitName',
            'load',
            'active',
            'enabled',
            'mainPid',
            'restarts',
            'fragmentPath',
            'dropInPaths',
            'needsReload',
        ]);
        const scope: ConnectorServiceScope | undefined = Object.values(ConnectorServiceScope).find(
            (entry): boolean => entry === value['scope'],
        );
        const load: ConnectorServiceLoadState | undefined = Object.values(
            ConnectorServiceLoadState,
        ).find((entry): boolean => entry === value['load']);
        const active: ConnectorServiceActiveState | undefined = Object.values(
            ConnectorServiceActiveState,
        ).find((entry): boolean => entry === value['active']);
        const enabled: ConnectorServiceEnabledState | undefined = Object.values(
            ConnectorServiceEnabledState,
        ).find((entry): boolean => entry === value['enabled']);
        const unitName: string = Boundary.text(value['unitName']);
        if (
            scope === undefined ||
            load === undefined ||
            active === undefined ||
            enabled === undefined ||
            !/^nerva-connector-[a-f0-9]{64}\.service$/u.test(unitName)
        ) {
            throw new Error('Unsupported service observation');
        }
        const mainPid: number | null =
            value['mainPid'] === null ? null : Boundary.count(value['mainPid'], 2147483647);
        const restarts: string | null =
            value['restarts'] === null ? null : Boundary.integer(value['restarts']).toString();
        if (
            typeof value['fragmentPath'] !== 'string' ||
            typeof value['dropInPaths'] !== 'string' ||
            value['fragmentPath'].length > 4096 ||
            value['dropInPaths'].length > 8192 ||
            (load !== ConnectorServiceLoadState.NotFound && (mainPid === null || restarts === null))
        ) {
            throw new Error('Incomplete service observation');
        }
        if (
            load === ConnectorServiceLoadState.NotFound &&
            (active !== ConnectorServiceActiveState.Inactive ||
                mainPid !== null ||
                restarts !== null ||
                value['fragmentPath'] !== '')
        ) {
            throw new Error('Conflicting absent service observation');
        }
        return {
            scope,
            unitName,
            load,
            active,
            enabled,
            mainPid,
            restarts,
            fragmentPath: value['fragmentPath'],
            dropInPaths: value['dropInPaths'],
            needsReload: Boundary.boolean(value['needsReload']),
        };
    }
}
