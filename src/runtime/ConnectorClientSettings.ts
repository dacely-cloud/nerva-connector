// SPDX-FileCopyrightText: 2026 Nerva contributors
// SPDX-License-Identifier: LicenseRef-Proprietary

/** Local grants and cloud public-key pin never contain the backend's private signing authority. */
export interface ConnectorLocalCapabilitySettings {
    readonly policyFile: string;
    readonly stateDirectory: string;
}
/** Every configuration explicitly chooses file and execution support independently; missing choices are rejected. */
export interface ConnectorClientSettings {
    readonly authorityId: string;
    readonly authorityPublicKeyFile: string;
    readonly environmentId: string;
    readonly enrollmentId: string;
    readonly slot: number;
    readonly endpoints: readonly string[];
    readonly privateKeyFile: string;
    readonly serverCaFile: string | null;
    readonly files: ConnectorLocalCapabilitySettings | null;
    readonly execution: ConnectorLocalCapabilitySettings | null;
}
