// SPDX-FileCopyrightText: 2026 Nerva contributors
// SPDX-License-Identifier: LicenseRef-Proprietary

import { Boundary } from 'nerva-connector-protocol/protocol/Boundary.js';

/** JSON values admitted at the MCP transport boundary. */
export type HostJsonValue =
    null | boolean | number | string | HostJsonObject | readonly HostJsonValue[];

/** Named JSON object contract for tool arguments and schemas. */
export interface HostJsonObject {
    readonly [name: string]: HostJsonValue;
}

/** Public MCP tool metadata with a bounded JSON Schema. */
export interface HostMcpTool {
    readonly name: string;
    readonly description: string;
    readonly inputSchema: HostJsonObject;
}

/** Transport-independent tool owner; returned text preserves exact serialized quantities. */
export interface HostMcpTools {
    readonly tools: readonly HostMcpTool[];
    call(name: string, argumentsValue: HostJsonObject): Promise<string>;
}

/** One validated JSON-RPC request or notification. */
export interface HostMcpRequest {
    readonly id: string | number | null;
    readonly notification: boolean;
    readonly method: string;
    readonly params: HostJsonObject;
}

/** Strict JSON-RPC admission before dispatching any computer operation. */
export class HostMcpProtocol {
    /** Current implementation supports one explicit protocol version. */
    public static readonly version: string = '2025-11-25';
    /** Bound frames before decoding or allocating a parsed request tree. */
    public static readonly maximumBytes: number = 262144;

    /** Validate message identity, method, and complete JSON arguments at the untrusted boundary. */
    public static request(raw: unknown): HostMcpRequest {
        const value: Readonly<Record<string, unknown>> = Boundary.record(raw, [
            'jsonrpc',
            'id',
            'method',
            'params',
        ]);
        if (
            value['jsonrpc'] !== '2.0' ||
            typeof value['method'] !== 'string' ||
            value['method'].length < 1 ||
            value['method'].length > 128
        ) {
            throw new Error('Invalid JSON-RPC request');
        }
        const notification: boolean = !Object.hasOwn(value, 'id');
        const id: unknown = value['id'];
        if (
            !notification &&
            !(typeof id === 'string' && id.length <= 128) &&
            !(typeof id === 'number' && Number.isSafeInteger(id))
        ) {
            throw new Error('Invalid JSON-RPC request identity');
        }
        const params: HostJsonValue = this.#json(value['params'] ?? {}, 0, { remaining: 32768 });
        if (params === null || typeof params !== 'object' || Array.isArray(params)) {
            throw new Error('Invalid JSON-RPC parameters');
        }
        return {
            id: notification ? null : typeof id === 'string' || typeof id === 'number' ? id : null,
            notification,
            method: value['method'],
            params: params as HostJsonObject,
        };
    }

    static #json(raw: unknown, depth: number, budget: HostJsonBudget): HostJsonValue {
        budget.remaining -= 1;
        if (depth > 32 || budget.remaining < 0) {
            throw new Error('MCP JSON resource limit exceeded');
        }
        if (raw === null || typeof raw === 'boolean' || typeof raw === 'string') {
            return raw;
        }
        if (typeof raw === 'number' && Number.isFinite(raw)) {
            return raw;
        }
        if (Array.isArray(raw)) {
            return raw.map((entry: unknown): HostJsonValue => this.#json(entry, depth + 1, budget));
        }
        if (
            raw === null ||
            typeof raw !== 'object' ||
            Object.getPrototypeOf(raw) !== Object.prototype
        ) {
            throw new Error('Invalid MCP JSON value');
        }
        const entries: readonly [string, unknown][] = Object.entries(raw);
        if (entries.length > 256) {
            throw new Error('MCP object resource limit exceeded');
        }
        return Object.fromEntries(
            entries.map(([name, entry]: [string, unknown]): [string, HostJsonValue] => [
                name,
                this.#json(entry, depth + 1, budget),
            ]),
        );
    }
}

/** Mutable budget belongs to one validation walk and is never shared across requests. */
interface HostJsonBudget {
    remaining: number;
}
