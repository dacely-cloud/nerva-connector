// SPDX-FileCopyrightText: 2026 Nerva contributors
// SPDX-License-Identifier: LicenseRef-Proprietary

import { lstat } from 'node:fs/promises';
import { join } from 'node:path';
import { ProtectedFiles } from '../local/ProtectedFiles.js';
import type { ConnectorPrivateDirectory } from '../runtime/ConnectorPrivateDirectory.js';
import { ConnectorNativePlans } from './ConnectorNativePlan.js';
import type { ConnectorNativePlan, ConnectorNativeLayout } from './ConnectorNativeTypes.js';

/** Atomic private leaves retain native setup authority without another configuration version or key copy. */
export class ConnectorNativeStore {
    /** Absence means native preparation was never configured; unreadable or incomplete native state is an error. */
    public static async present(directory: string): Promise<boolean> {
        await ProtectedFiles.directory(directory);
        try {
            await lstat(join(directory, 'native'));
            return true;
        } catch (caught: unknown) {
            if (caught instanceof Error && 'code' in caught && caught.code === 'ENOENT') {
                return false;
            }
            throw caught;
        }
    }
    /** Read-only boot validation never initializes a new native plan. */
    public static async read(layout: ConnectorNativeLayout): Promise<ConnectorNativePlan> {
        return ConnectorNativePlans.plan(
            JSON.parse(
                new TextDecoder('utf-8', { fatal: true }).decode(
                    await ProtectedFiles.readPrivate(join(layout.directory, 'plan.json'), 131072),
                ),
            ),
        );
    }
    /** Only an already acquired native root owner can advance the original preparation intent. */
    public static async write(
        owner: ConnectorPrivateDirectory,
        plan: ConnectorNativePlan,
        initialize: boolean,
    ): Promise<void> {
        await owner.cleanPartial('plan.json', 131072);
        await owner.write('plan.json', ConnectorNativePlans.encode(plan), 131072, initialize);
    }
    /** Final generated policies cannot be adopted from foreign bytes or recreated during boot. */
    public static async publish(
        owner: ConnectorPrivateDirectory,
        name: string,
        bytes: Buffer,
        preparing: boolean,
    ): Promise<void> {
        if (await owner.exists(name)) {
            if (!(await owner.read(name, 131072)).equals(bytes)) {
                throw new Error('Original native setup output changed');
            }
        } else if (preparing) {
            await owner.cleanPartial(name, 131072);
            await owner.write(name, bytes, 131072, true);
        } else {
            throw new Error('Original native setup output disappeared');
        }
    }
}
