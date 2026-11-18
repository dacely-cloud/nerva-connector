// SPDX-FileCopyrightText: 2026 Nerva contributors
// SPDX-License-Identifier: LicenseRef-Proprietary

import type { ConnectorAuthorization } from 'nerva-connector-protocol/protocol/ConnectorAuthorization.js';
import { ConnectorAuthorizationProof } from 'nerva-connector-protocol/protocol/ConnectorAuthorizationProof.js';
import { ConnectorEffectKind, type ConnectorEffectContext } from './ConnectorEffectContext.js';
import { ConnectorEffectContextCodec } from './ConnectorEffectContextCodec.js';
import { ConnectorFileJobsCodec } from 'nerva-connector-protocol/protocol/ConnectorFileJobsCodec.js';
import { ConnectorFilesCodec } from 'nerva-connector-protocol/protocol/ConnectorFilesCodec.js';
import type { ConnectorFileOperation } from 'nerva-connector-protocol/protocol/ConnectorFileJobs.js';
import type { ConnectorFileResponse } from 'nerva-connector-protocol/protocol/ConnectorFiles.js';
import { ConnectorFileProof } from 'nerva-connector-protocol/protocol/ConnectorFileProof.js';
import {
    ConnectorOperationPurpose,
    type ConnectorOperationCodec,
} from './ConnectorOperationCodec.js';

/** File normalization retains the current exact wire contract and independent file journal identity. */
export class ConnectorFileJournalCodec implements ConnectorOperationCodec<
    ConnectorFileOperation,
    ConnectorFileResponse
> {
    /** File keys, lock and file basename cannot be substituted for an execution journal. */
    public readonly purpose: ConnectorOperationPurpose = ConnectorOperationPurpose.Files;
    /** File operations have no intermediate result authority. */
    public readonly progress: null = null;
    /** Deserialized operations acquire only the finite named file capability. */
    public request(raw: unknown): ConnectorFileOperation {
        return ConnectorFileJobsCodec.operation(raw);
    }
    /** Captured physical authority belongs only to this original file policy/root, never a retagged alias. */
    public effectContext(raw: unknown, request: ConnectorFileOperation): ConnectorEffectContext {
        const context: ConnectorEffectContext = ConnectorEffectContextCodec.read(raw);
        if (
            context.kind === ConnectorEffectKind.HistoricalUnproven ||
            (context.kind === ConnectorEffectKind.CapturedFile &&
                context.policySha256 === request.policySha256 &&
                context.rootId === request.rootId)
        ) {
            return context;
        }
        throw new Error('File effect context does not match its original request');
    }
    /** Results remain correlated to the original operation before durability or hashing. */
    public response(raw: unknown, request: ConnectorFileOperation): ConnectorFileResponse {
        return ConnectorFilesCodec.response(raw, request);
    }
    /** Canonical file request bytes retain their existing signature commitment. */
    public requestHash(request: ConnectorFileOperation): string {
        return ConnectorFileProof.digest(ConnectorFileJobsCodec.encode(request));
    }
    /** The concrete receiver fixes the operation channel and lane independently of untrusted envelope fields. */
    public admissionHash(requestHash: string, authorization: ConnectorAuthorization): string {
        return ConnectorAuthorizationProof.file(requestHash, authorization);
    }
    /** Canonical file response bytes retain their existing signature commitment. */
    public responseHash(response: ConnectorFileResponse): string {
        return ConnectorFileProof.responseHash(response);
    }
}
