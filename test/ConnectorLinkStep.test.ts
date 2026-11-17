// SPDX-FileCopyrightText: 2026 Nerva contributors
// SPDX-License-Identifier: LicenseRef-Proprietary

import { expect, it } from 'vitest';
import {
    ConnectorLinkOutcomeKind,
    ConnectorLinkStep,
    type ConnectorLinkOutcome,
    type ConnectorLinkRunner,
} from '../src/cli/ConnectorLinkStep.js';
import {
    ConnectorPairEventKind,
    ConnectorPairIntent,
    type ConnectorPairCompleted,
    type ConnectorPairEvent,
} from '../src/runtime/ConnectorPairClient.js';
import {
    ConnectorStartupStage,
    type ConnectorStartupObserver,
} from '../src/runtime/ConnectorStartup.js';
import {
    ConnectorPromptAction,
    ConnectorPromptTone,
    type ConnectorPromptPanel,
} from '../src/cli/ConnectorPromptTypes.js';
import { ConnectorPromptFixture } from './support/ConnectorPromptFixture.js';

/** The verified completion a real pairing run would report; only public fields. */
const completed: ConnectorPairCompleted = {
    state: ConnectorPairEventKind.Paired,
    configurationFile: '/owned/device.json',
    enrollmentId: 'enrollment',
    publicKey: 'public',
};

/** One scripted pairing attempt. */
type Attempt = (
    signal: AbortSignal,
    observe: (event: ConnectorPairEvent) => void,
    progress: ConnectorStartupObserver,
) => Promise<void>;

/** Replays scripted attempts in order and records the intent each one received. */
class FakePairing {
    public readonly intents: ConnectorPairIntent[] = [];
    readonly #attempts: readonly Attempt[];
    public constructor(attempts: readonly Attempt[]) {
        this.#attempts = attempts;
    }
    /** Matches `ConnectorPairClient.run` without any network, key or file access. */
    public readonly runner: ConnectorLinkRunner = async (
        signal: AbortSignal,
        intent: ConnectorPairIntent,
        observe: (event: ConnectorPairEvent) => void,
        progress: ConnectorStartupObserver,
    ): Promise<void> => {
        const attempt: Attempt | undefined = this.#attempts[this.intents.length];
        this.intents.push(intent);
        if (attempt === undefined) {
            throw new Error('Unexpected pairing attempt');
        }
        await attempt(signal, observe, progress);
    };
}

/** A successful approval after showing a code. */
const approve: Attempt = async (
    _signal: AbortSignal,
    observe: (event: ConnectorPairEvent) => void,
    progress: ConnectorStartupObserver,
): Promise<void> => {
    progress({ stage: ConnectorStartupStage.LocalSecurity });
    progress({ stage: ConnectorStartupStage.Dns });
    progress({ stage: ConnectorStartupStage.PairingRequest });
    observe({
        state: ConnectorPairEventKind.Waiting,
        verificationUri: 'https://nervalabs.com/chat/connectors',
        code: 'BY3Y-58N8',
        expiresAtMs: BigInt(Date.now()) + 600000n,
        publicKey: 'public',
    });
    progress({ stage: ConnectorStartupStage.Approval });
    await Promise.resolve();
    progress({ stage: ConnectorStartupStage.Saving });
    observe(completed);
};

/** Waits until the attempt is canceled, as a real poll loop would. */
async function pending(signal: AbortSignal): Promise<void> {
    const done: PromiseWithResolvers<undefined> = Promise.withResolvers<undefined>();
    signal.addEventListener('abort', (): void => done.resolve(undefined), { once: true });
    await done.promise;
    signal.throwIfAborted();
}

/** Runs the link step with test defaults. */
async function link(
    pairing: FakePairing,
    questions: ConnectorPromptFixture,
    lines: readonly string[] = [],
): Promise<ConnectorLinkOutcome> {
    return await ConnectorLinkStep.run({
        questions,
        signal: new AbortController().signal,
        computerName: 'Game workstation',
        step: { current: 6, total: 6 },
        pair: pairing.runner,
        afterLink: (): Promise<readonly string[]> => Promise.resolve(lines),
        successPauseMs: 0,
    });
}

it('shows the code and page prominently, then a success screen with what setup applied', async (): Promise<void> => {
    const pairing: FakePairing = new FakePairing([approve]);
    const questions: ConnectorPromptFixture = new ConnectorPromptFixture([]);
    const outcome: ConnectorLinkOutcome = await link(pairing, questions, [
        'Full computer access is on. Turn it off anytime with /disable-host.',
    ]);
    expect(outcome).toEqual({ kind: ConnectorLinkOutcomeKind.Linked, completed });
    expect(pairing.intents).toEqual([ConnectorPairIntent.Resume]);
    const code: ConnectorPromptPanel | undefined = questions.panels.find(
        (panel: ConnectorPromptPanel): boolean => panel.code !== undefined,
    );
    expect(code).toMatchObject({
        title: 'Link to your Nerva account',
        link: 'https://nervalabs.com/chat/connectors',
        code: 'BY3Y-58N8',
        step: { current: 6, total: 6 },
        hint: 'Esc link later · Ctrl+C quit',
    });
    expect(code?.caption).toMatch(/^Code BY3Y-58N8 · expires in (10:00|9:5\d)$/u);
    expect(code?.status).toEqual({
        text: 'Waiting for you to approve this computer…',
        tone: ConnectorPromptTone.Neutral,
        busy: true,
    });
    const done: ConnectorPromptPanel | undefined = questions.panels.at(-1);
    expect(done?.title).toBe("You're connected!");
    expect(done?.tone).toBe(ConnectorPromptTone.Success);
    expect(done?.description).toContain(
        'Full computer access is on. Turn it off anytime with /disable-host.',
    );
    expect(questions.output).not.toMatch(/Verifying|TLS|tunnel|signed/iu);
    expect(questions.confirms.map((confirm): string => confirm.label)).toEqual(['Continue']);
});

it('an expired code is explained and Enter gets a new one with the renewal intent', async (): Promise<void> => {
    const pairing: FakePairing = new FakePairing([
        (_signal: AbortSignal, observe: (event: ConnectorPairEvent) => void): Promise<void> => {
            observe({ state: ConnectorPairEventKind.Expired });
            return Promise.reject(new Error('Connector pairing code expired'));
        },
        approve,
    ]);
    const questions: ConnectorPromptFixture = new ConnectorPromptFixture(['']);
    expect((await link(pairing, questions)).kind).toBe(ConnectorLinkOutcomeKind.Linked);
    expect(pairing.intents).toEqual([ConnectorPairIntent.Resume, ConnectorPairIntent.RenewExpired]);
    expect(questions.panels).toContainEqual(
        expect.objectContaining({ title: 'Your code expired', tone: ConnectorPromptTone.Error }),
    );
    expect(questions.confirms[0]?.label).toBe('Get a new code');
});

it('network trouble is retried with a visible countdown, both inside pairing and after a failed attempt', async (): Promise<void> => {
    const pairing: FakePairing = new FakePairing([
        (
            _signal: AbortSignal,
            _observe: unknown,
            progress: ConnectorStartupObserver,
        ): Promise<void> => {
            progress({ stage: ConnectorStartupStage.Tcp });
            return Promise.reject(Object.assign(new Error('unused'), { code: 'ECONNREFUSED' }));
        },
        async (
            signal: AbortSignal,
            observe: (event: ConnectorPairEvent) => void,
            progress: ConnectorStartupObserver,
        ): Promise<void> => {
            progress({ stage: ConnectorStartupStage.Dns });
            progress({ stage: ConnectorStartupStage.Retry, retryAfterMs: 3000 });
            await approve(signal, observe, progress);
        },
    ]);
    const questions: ConnectorPromptFixture = new ConnectorPromptFixture(['']);
    expect((await link(pairing, questions)).kind).toBe(ConnectorLinkOutcomeKind.Linked);
    expect(questions.panels).toContainEqual(
        expect.objectContaining({
            title: "Can't reach Nerva",
            description: ['Check your internet connection.'],
            tone: ConnectorPromptTone.Warning,
            status: { text: 'Retrying in 5s…', tone: ConnectorPromptTone.Warning, busy: true },
        }),
    );
    expect(questions.confirms[0]?.label).toBe('Try again now');
    expect(
        questions.panels.some(
            (panel: ConnectorPromptPanel): boolean =>
                panel.status?.text ===
                "Can't reach Nerva. Check your internet connection. Retrying in 3s…",
        ),
    ).toBe(true);
});

it('Esc while waiting links later and stops the pairing attempt; Ctrl+C on a failure cancels', async (): Promise<void> => {
    const stopped: AbortSignal[] = [];
    const later: FakePairing = new FakePairing([
        async (signal: AbortSignal): Promise<void> => {
            stopped.push(signal);
            await pending(signal);
        },
    ]);
    expect(
        await link(later, new ConnectorPromptFixture([{ action: ConnectorPromptAction.Back }])),
    ).toEqual({ kind: ConnectorLinkOutcomeKind.Later });
    expect(stopped[0]?.aborted).toBe(true);
    const failing: FakePairing = new FakePairing([
        (): Promise<void> => Promise.reject(new Error('opaque local failure')),
    ]);
    expect(await link(failing, new ConnectorPromptFixture([null]))).toEqual({
        kind: ConnectorLinkOutcomeKind.Canceled,
    });
});

it('a declined or removed link offers to start over instead of retrying the same request', async (): Promise<void> => {
    for (const state of [ConnectorPairEventKind.Denied, ConnectorPairEventKind.Revoked] as const) {
        const pairing: FakePairing = new FakePairing([
            (_signal: AbortSignal, observe: (event: ConnectorPairEvent) => void): Promise<void> => {
                observe({ state });
                return Promise.reject(new Error('terminal'));
            },
        ]);
        const questions: ConnectorPromptFixture = new ConnectorPromptFixture(['']);
        expect(await link(pairing, questions)).toEqual({
            kind: ConnectorLinkOutcomeKind.StartOver,
        });
        expect(questions.confirms[0]?.label).toBe('Start over');
        expect(pairing.intents).toHaveLength(1);
    }
});
