// SPDX-FileCopyrightText: 2026 Dacely <business@dacely.com>
// SPDX-License-Identifier: LicenseRef-Proprietary

import { it, type TestContext } from 'vitest';
import { SigningKey } from '../src/identity/SigningKey.js';
import { SignaturePurpose } from 'nerva-connector-protocol/identity/IdentityFormat.js';

it('measures both signatures on the same valid 1 KiB operation', async ({
    bench,
}: TestContext): Promise<void> => {
    using key: SigningKey = SigningKey.generate();
    const payload: Buffer = Buffer.alloc(1024, 42);
    const proof: string = key.sign(SignaturePurpose.RemoteRequest, payload);
    await bench('ML-DSA-44 and Ed25519: sign a 1 KiB operation', (): void => {
        key.sign(SignaturePurpose.RemoteRequest, payload);
    }).run({ time: 1000, warmupTime: 100 });
    await bench('ML-DSA-44 and Ed25519: verify a 1 KiB operation', (): void => {
        if (!SigningKey.verify(SignaturePurpose.RemoteRequest, key.publicKey, payload, proof)) {
            throw new Error('Valid benchmark operation rejected');
        }
    }).run({ time: 1000, warmupTime: 100 });
});
