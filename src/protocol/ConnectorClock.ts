// SPDX-FileCopyrightText: 2026 Dacely <business@dacely.com>
// SPDX-License-Identifier: LicenseRef-Proprietary

import { ConnectorDeviceLimits } from 'nerva-connector-protocol/protocol/ConnectorDevice.js';

/**
 * Compares a time Nerva signed with this computer's clock.
 *
 * @remarks
 * Nerva stamps challenges, leases, permits and activations with its own clock. A computer whose clock runs a
 * little behind receives them before that moment by its own reading. Every such check therefore tolerates the same
 * {@link ConnectorDeviceLimits.clockLeadMs} lead the signed handshake does, so a computer that can sign in can also
 * accept the work its lease carries. Without it, a Windows clock 0.4 s behind signed in and then refused every
 * full-computer permit as issued in the future, reconnecting every 31 s with nothing completing. Expiry stays exact
 * by this computer's clock, and Nerva's hello check keeps a computer from signing in more than the same lead ahead.
 */
export class ConnectorClock {
    /**
     * Whether a Nerva-issued time has been reached, allowing for this computer's clock running behind.
     *
     * @param issuedAtMs - The time Nerva signed
     * @param nowMs - This computer's clock
     * @returns `true` unless the time is more than the clock lead ahead of `nowMs`
     */
    public static issued(issuedAtMs: bigint, nowMs: bigint): boolean {
        return issuedAtMs <= nowMs + ConnectorDeviceLimits.clockLeadMs;
    }
}
