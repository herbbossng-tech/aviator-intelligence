import { describe, expect, it } from 'vitest';
import { MAX_MINOR_AMOUNT } from './money.js';
import {
  createProgressionState,
  cycleNetAfterWinMinor,
  decideNextStake,
  martingaleStakeMinor,
  MAX_CUSTOM_SEQUENCE_LENGTH,
  MAX_PROGRESSION_STEPS,
  parseProgressionConfig,
  parseProgressionState,
  progressionConfigKey,
  ProgressionError,
  resolveStake,
  type ProgressionConfig,
  type ProgressionDecision,
  type ProgressionOutcome,
  type ProgressionState,
} from './progression.js';

// Arithmetic examples only: none of these configurations is a recommendation.

const BIG_BANKROLL = 1_000_000_000_000;

function fixed(overrides: Partial<Extract<ProgressionConfig, { mode: 'fixed' }>> = {}) {
  return parseProgressionConfig({
    schemaVersion: 1,
    currency: 'NGN',
    winResetPolicy: 'reset_to_base',
    mode: 'fixed',
    baseStakeMinor: 50_000,
    limits: { maxSteps: 10, maxStakeMinor: null, maxCycleExposureMinor: null },
    ...overrides,
  });
}

function martingale(
  limits: Partial<{
    maxSteps: number;
    maxStakeMinor: number | null;
    maxCycleExposureMinor: number;
  }> = {},
  overrides: Record<string, unknown> = {},
) {
  return parseProgressionConfig({
    schemaVersion: 1,
    currency: 'NGN',
    winResetPolicy: 'reset_to_base',
    mode: 'martingale',
    baseStakeMinor: 50_000,
    multiplierX100: 200,
    limits: { maxSteps: 6, maxStakeMinor: null, maxCycleExposureMinor: 3_150_000, ...limits },
    ...overrides,
  });
}

function capped(
  limits: Partial<{
    maxSteps: number;
    maxStakeMinor: number;
    maxCycleExposureMinor: number | null;
  }> = {},
  overrides: Record<string, unknown> = {},
) {
  return parseProgressionConfig({
    schemaVersion: 1,
    currency: 'NGN',
    winResetPolicy: 'reset_to_base',
    mode: 'capped_martingale',
    baseStakeMinor: 50_000,
    multiplierX100: 200,
    limits: { maxSteps: 10, maxStakeMinor: 400_000, maxCycleExposureMinor: null, ...limits },
    ...overrides,
  });
}

function custom(stakesMinor: number[], limits: Record<string, unknown> = {}) {
  return parseProgressionConfig({
    schemaVersion: 1,
    currency: 'NGN',
    winResetPolicy: 'reset_to_base',
    mode: 'custom',
    stakesMinor,
    afterFinalStep: 'stop',
    limits: { maxStakeMinor: null, maxCycleExposureMinor: null, ...limits },
  });
}

/** Decides and resolves one stake; returns both results. Fails the test if not a stake. */
function play(
  config: ProgressionConfig,
  state: ProgressionState,
  outcome: ProgressionOutcome,
  bankroll = BIG_BANKROLL,
) {
  const decision = decideNextStake(config, state, { availableBankrollMinor: bankroll });
  if (decision.kind !== 'stake') throw new Error(`expected a stake, got ${decision.kind}`);
  const resolution = resolveStake(config, decision.state, {
    decisionId: decision.decisionId,
    outcome,
  });
  return { decision, resolution, state: resolution.state };
}

function stakesUntilStop(config: ProgressionConfig, bankroll = BIG_BANKROLL) {
  let state = createProgressionState(config);
  const stakes: number[] = [];
  for (;;) {
    const decision = decideNextStake(config, state, { availableBankrollMinor: bankroll });
    if (decision.kind !== 'stake') return { stakes, decision, state };
    stakes.push(decision.stakeMinor);
    state = resolveStake(config, decision.state, {
      decisionId: decision.decisionId,
      outcome: 'loss',
    }).state;
  }
}

function errorCode(fn: () => unknown): string {
  try {
    fn();
  } catch (error) {
    if (error instanceof ProgressionError) return error.code;
    throw error;
  }
  throw new Error('expected a ProgressionError');
}

function deepFreeze<T>(value: T): T {
  if (typeof value === 'object' && value !== null) {
    for (const v of Object.values(value)) deepFreeze(v);
    Object.freeze(value);
  }
  return value;
}

describe('fixed mode', () => {
  it('stakes the base amount after losses and wins, and accounts for cycle losses', () => {
    const config = fixed();
    let state = createProgressionState(config);
    const seen: [number, number][] = [];
    for (const outcome of ['loss', 'loss', 'win', 'loss'] as const) {
      const r = play(config, state, outcome);
      seen.push([r.decision.stakeMinor, r.resolution.cycleLossAfterMinor]);
      state = r.state;
    }
    expect(seen).toEqual([
      [50_000, 50_000],
      [50_000, 100_000],
      [50_000, 0],
      [50_000, 50_000],
    ]);
    expect(state).toMatchObject({
      step: 1,
      cycleLossMinor: 50_000,
      cyclesCompleted: 1,
      resolvedCount: 4,
    });
  });

  it('blocks after maxSteps consecutive losses', () => {
    const { stakes, decision } = stakesUntilStop(
      fixed({ limits: { maxSteps: 3, maxStakeMinor: null, maxCycleExposureMinor: null } }),
    );
    expect(stakes).toEqual([50_000, 50_000, 50_000]);
    expect(decision).toMatchObject({
      kind: 'blocked',
      reason: 'max_steps_reached',
      step: 3,
      requestedStakeMinor: null,
      cycleLossMinor: 150_000,
    });
  });
});

describe('martingale mode', () => {
  it('doubles after each loss: the documented ₦500 example', () => {
    const { stakes, decision, state } = stakesUntilStop(martingale());
    expect(stakes).toEqual([50_000, 100_000, 200_000, 400_000, 800_000, 1_600_000]);
    expect(stakes.reduce((a, b) => a + b, 0)).toBe(3_150_000); // ₦31,500
    expect(decision).toMatchObject({ kind: 'blocked', reason: 'max_steps_reached', step: 6 });
    expect(state.cycleLossMinor).toBe(3_150_000);
  });

  it('uses zero-based steps and resets to the base stake after a win, clearing cycle losses', () => {
    const config = martingale();
    let state = createProgressionState(config);
    const a = play(config, state, 'loss');
    expect(a.decision).toMatchObject({
      step: 0,
      stakeMinor: 50_000,
      cycleLossBeforeMinor: 0,
      exposureIfLostMinor: 50_000,
    });
    const b = play(config, a.state, 'loss');
    expect(b.decision).toMatchObject({
      step: 1,
      stakeMinor: 100_000,
      cycleLossBeforeMinor: 50_000,
    });
    const c = play(config, b.state, 'win');
    expect(c.decision).toMatchObject({
      step: 2,
      stakeMinor: 200_000,
      exposureIfLostMinor: 350_000,
    });
    expect(c.resolution).toMatchObject({
      cycleReset: true,
      cycleLossBeforeMinor: 150_000,
      cycleLossAfterMinor: 0,
    });
    state = c.state;
    expect(state).toMatchObject({
      step: 0,
      cycleLossMinor: 0,
      cyclesCompleted: 1,
      resolvedCount: 3,
    });
    const d = play(config, state, 'loss');
    expect(d.decision).toMatchObject({ step: 0, stakeMinor: 50_000, decisionId: 3 });
  });

  it('blocks when losses plus the next stake would exceed the cycle exposure limit', () => {
    // 500 + 1,000 + 2,000 = 3,500 lost; 3,500 + 4,000 > 7,000.
    const { stakes, decision } = stakesUntilStop(martingale({ maxCycleExposureMinor: 700_000 }));
    expect(stakes).toEqual([50_000, 100_000, 200_000]);
    expect(decision).toMatchObject({
      kind: 'blocked',
      reason: 'cycle_exposure_exceeded',
      step: 3,
      requestedStakeMinor: 400_000,
      cycleLossMinor: 350_000,
    });
  });

  it('requires a cycle exposure limit and a step limit', () => {
    expect(errorCode(() => martingale({ maxCycleExposureMinor: undefined as never }))).toBe(
      'invalid_config',
    );
    expect(() =>
      parseProgressionConfig({
        schemaVersion: 1,
        currency: 'NGN',
        winResetPolicy: 'reset_to_base',
        mode: 'martingale',
        baseStakeMinor: 1,
        multiplierX100: 200,
        limits: { maxStakeMinor: null, maxCycleExposureMinor: 10 },
      }),
    ).toThrow(ProgressionError);
  });
});

describe('capped martingale mode', () => {
  it('blocks when the next stake would exceed the maximum stake, without clamping it', () => {
    const { stakes, decision } = stakesUntilStop(capped({ maxStakeMinor: 300_000 }));
    expect(stakes).toEqual([50_000, 100_000, 200_000]);
    expect(decision).toMatchObject({
      kind: 'blocked',
      reason: 'max_stake_exceeded',
      requestedStakeMinor: 400_000,
    });
  });

  it('blocks at the configured maximum step', () => {
    const { stakes, decision } = stakesUntilStop(capped({ maxSteps: 2 }));
    expect(stakes).toEqual([50_000, 100_000]);
    expect(decision).toMatchObject({ kind: 'blocked', reason: 'max_steps_reached', step: 2 });
  });

  it('applies an optional exposure limit too', () => {
    const { decision } = stakesUntilStop(
      capped({ maxStakeMinor: 1_000_000, maxCycleExposureMinor: 300_000 }),
    );
    expect(decision).toMatchObject({ reason: 'cycle_exposure_exceeded', step: 2 });
  });

  it('never places a blocked stake implicitly: the blocked state returns the same block', () => {
    const { decision } = stakesUntilStop(capped({ maxStakeMinor: 300_000 }));
    if (decision.kind !== 'blocked') throw new Error('expected blocked');
    expect(decision.state).toMatchObject({
      status: 'blocked',
      blockReason: 'max_stake_exceeded',
      pendingDecision: null,
    });
    const again = decideNextStake(capped({ maxStakeMinor: 300_000 }), decision.state, {
      availableBankrollMinor: BIG_BANKROLL,
    });
    expect(again).toEqual(decision);
    expect(
      errorCode(() =>
        resolveStake(capped({ maxStakeMinor: 300_000 }), decision.state, {
          decisionId: 3,
          outcome: 'win',
        }),
      ),
    ).toBe('no_pending_decision');
  });

  it('requires the maximum stake, and the base stake must pass every cap', () => {
    expect(errorCode(() => capped({ maxStakeMinor: null as never }))).toBe('invalid_config');
    expect(errorCode(() => capped({ maxStakeMinor: 49_999 }))).toBe('invalid_config');
    expect(errorCode(() => martingale({ maxCycleExposureMinor: 49_999 }))).toBe('invalid_config');
  });
});

describe('custom sequences', () => {
  it('uses every step in order, then is exhausted after a loss on the final step', () => {
    const config = custom([100, 300, 700]);
    const { stakes, decision, state } = stakesUntilStop(config);
    expect(stakes).toEqual([100, 300, 700]);
    expect(decision).toMatchObject({
      kind: 'exhausted',
      reason: 'sequence_exhausted',
      step: 3,
      cycleLossMinor: 1_100,
    });
    expect(state.step).toBe(3);
    if (decision.kind !== 'exhausted') throw new Error('expected exhausted');
    // Exhausted is terminal: no invented fourth stake.
    expect(
      decideNextStake(config, decision.state, { availableBankrollMinor: BIG_BANKROLL }),
    ).toEqual(decision);
  });

  it('restarts the sequence after a win', () => {
    const config = custom([100, 300, 700]);
    const a = play(config, createProgressionState(config), 'loss');
    const b = play(config, a.state, 'win');
    expect(b.decision.stakeMinor).toBe(300);
    expect(play(config, b.state, 'loss').decision.stakeMinor).toBe(100);
  });

  it('applies optional caps to custom stakes', () => {
    expect(stakesUntilStop(custom([100, 300, 700], { maxStakeMinor: 500 })).decision).toMatchObject(
      { reason: 'max_stake_exceeded', step: 2 },
    );
    expect(
      stakesUntilStop(custom([100, 300, 700], { maxCycleExposureMinor: 399 })).decision,
    ).toMatchObject({ reason: 'cycle_exposure_exceeded', step: 1 });
  });

  it('rejects empty, invalid, over-long and over-limit sequences', () => {
    for (const stakes of [
      [],
      [0],
      [100, -1],
      [100, 1.5],
      [Number.NaN],
      [Infinity],
      [MAX_MINOR_AMOUNT + 1],
      new Array<number>(MAX_CUSTOM_SEQUENCE_LENGTH + 1).fill(1),
    ]) {
      expect(
        errorCode(() => custom(stakes)),
        JSON.stringify(stakes.slice(0, 3)),
      ).toBe('invalid_config');
    }
    expect(custom(new Array<number>(MAX_CUSTOM_SEQUENCE_LENGTH).fill(1)).mode).toBe('custom');
    expect(errorCode(() => custom([100], { maxStakeMinor: 50 }))).toBe('invalid_config');
  });
});

describe('configuration contract', () => {
  it('rejects unknown fields, unknown modes and policies, and bad multipliers', () => {
    const base = {
      schemaVersion: 1,
      currency: 'NGN',
      winResetPolicy: 'reset_to_base',
      mode: 'martingale',
      baseStakeMinor: 50_000,
      multiplierX100: 200,
      limits: { maxSteps: 6, maxStakeMinor: null, maxCycleExposureMinor: 3_150_000 },
    };
    expect(parseProgressionConfig(base).mode).toBe('martingale');
    for (const bad of [
      { ...base, extra: 1 },
      { ...base, limits: { ...base.limits, extra: 1 } },
      { ...base, mode: 'reverse_martingale' },
      { ...base, winResetPolicy: 'keep_progressing' },
      { ...base, multiplierX100: 100 },
      { ...base, multiplierX100: 1_001 },
      { ...base, multiplierX100: 2.5 },
      { ...base, baseStakeMinor: 0 },
      { ...base, baseStakeMinor: 500.5 },
      { ...base, currency: 'BTC' },
      { ...base, limits: { ...base.limits, maxSteps: 0 } },
      { ...base, limits: { ...base.limits, maxSteps: MAX_PROGRESSION_STEPS + 1 } },
      { ...base, schemaVersion: 2 },
    ]) {
      expect(
        errorCode(() => parseProgressionConfig(bad)),
        JSON.stringify(bad).slice(0, 80),
      ).toBe('invalid_config');
    }
  });

  it('can never request a stake above the money limit: a required cap always blocks first', () => {
    // Martingale requires an exposure limit and capped Martingale a stake limit, both at most
    // MAX_MINOR_AMOUNT, so a deep doubling from 1 minor unit is blocked before it overflows.
    const deep = martingale(
      { maxSteps: 60, maxCycleExposureMinor: MAX_MINOR_AMOUNT },
      { baseStakeMinor: 1 },
    );
    const { stakes, decision } = stakesUntilStop(deep);
    expect(decision).toMatchObject({
      kind: 'blocked',
      reason: 'cycle_exposure_exceeded',
      step: 39,
    });
    expect(Math.max(...stakes)).toBe(2 ** 38);
    expect(stakes.every((x) => x <= MAX_MINOR_AMOUNT)).toBe(true);
    const cappedDeep = capped(
      { maxSteps: 1_000, maxStakeMinor: MAX_MINOR_AMOUNT },
      { multiplierX100: 1_000 },
    );
    expect(stakesUntilStop(cappedDeep).decision).toMatchObject({
      reason: 'max_stake_exceeded',
      step: 8,
    });
  });

  it('gives each configuration a deterministic key', () => {
    expect(progressionConfigKey(martingale())).toBe(progressionConfigKey(martingale()));
    expect(progressionConfigKey(martingale())).not.toBe(
      progressionConfigKey(martingale({ maxSteps: 5 })),
    );
    expect(progressionConfigKey(martingale())).toMatch(/^fnv1a64:[0-9a-f]{16}$/);
  });
});

describe('bankroll safety', () => {
  it('stakes when the bankroll covers the stake, and blocks (terminally) when it does not', () => {
    const config = martingale();
    const state = createProgressionState(config);
    expect(decideNextStake(config, state, { availableBankrollMinor: 50_000 }).kind).toBe('stake');
    const blocked = decideNextStake(config, state, { availableBankrollMinor: 49_999 });
    expect(blocked).toMatchObject({
      kind: 'blocked',
      reason: 'insufficient_bankroll',
      requestedStakeMinor: 50_000,
    });
    // Not reduced to an affordable amount, and not lifted by a larger bankroll later.
    expect(
      decideNextStake(config, blocked.state, { availableBankrollMinor: BIG_BANKROLL }),
    ).toMatchObject({
      kind: 'blocked',
      reason: 'insufficient_bankroll',
    });
  });

  it('checks configured caps before the bankroll', () => {
    const { state } = stakesUntilStop(martingale({ maxSteps: 2 }));
    expect(
      decideNextStake(
        martingale({ maxSteps: 2 }),
        { ...state, status: 'ready', blockReason: null },
        { availableBankrollMinor: 0 },
      ),
    ).toMatchObject({
      reason: 'max_steps_reached',
    });
  });

  it('never changes the bankroll it is given', () => {
    const input = deepFreeze({ availableBankrollMinor: 75_000 });
    const config = martingale();
    decideNextStake(config, createProgressionState(config), input);
    expect(input.availableBankrollMinor).toBe(75_000);
  });

  it('rejects invalid bankroll amounts', () => {
    const config = martingale();
    const state = createProgressionState(config);
    for (const amount of [-1, 1.5, Number.NaN, Infinity, Number.MAX_SAFE_INTEGER + 1, '100']) {
      expect(
        errorCode(() =>
          decideNextStake(config, state, { availableBankrollMinor: amount as number }),
        ),
        String(amount),
      ).toBe('invalid_input');
    }
    expect(decideNextStake(config, state, { availableBankrollMinor: 0 }).kind).toBe('blocked');
  });
});

describe('exact arithmetic', () => {
  it('computes ceil(base * m^k / 100^k) exactly for representative multipliers', () => {
    expect([0, 1, 2, 3, 4, 5].map((k) => martingaleStakeMinor(50_000, 200, k))).toEqual([
      50_000, 100_000, 200_000, 400_000, 800_000, 1_600_000,
    ]);
    // 1.5x on 333: 499.5 -> 500; 749.25 -> 750; 1123.875 -> 1124 (closed form, rounded up once).
    expect([0, 1, 2, 3].map((k) => martingaleStakeMinor(333, 150, k))).toEqual([
      333, 500, 750, 1_124,
    ]);
    // 2.10x on 1: 2.1 -> 3; 4.41 -> 5; 9.261 -> 10 (never understates the requirement).
    expect([1, 2, 3].map((k) => martingaleStakeMinor(1, 210, k))).toEqual([3, 5, 10]);
    // 1.01x keeps exact rational growth: 10,000 * 1.01^2 = 10,201.
    expect(martingaleStakeMinor(10_000, 101, 2)).toBe(10_201);
  });

  it('does not lose precision on very large intermediate products', () => {
    // 3^30 * 7 / 100^... : 9.99x for 12 steps on 1 minor unit = ceil(999^12 / 100^12).
    const expected = (999n ** 12n + 100n ** 12n - 1n) / 100n ** 12n;
    expect(BigInt(martingaleStakeMinor(1, 999, 12))).toBe(expected);
    // Double precision would get this wrong: 999^12 exceeds 2^53 by far.
    expect(999 ** 12 > Number.MAX_SAFE_INTEGER).toBe(true);
  });

  it('rejects over-limit and invalid calculations', () => {
    expect(() => martingaleStakeMinor(MAX_MINOR_AMOUNT, 200, 1)).toThrow(RangeError);
    expect(() => martingaleStakeMinor(1, 1_000, 13)).toThrow(/exceeds/);
    for (const args of [
      [0, 200, 1],
      [1.5, 200, 1],
      [1, 100, 1],
      [1, 200, -1],
      [1, 200, 0.5],
      [1, 200, MAX_PROGRESSION_STEPS],
    ] as [number, number, number][]) {
      expect(() => martingaleStakeMinor(...args), JSON.stringify(args)).toThrow(RangeError);
    }
  });

  it('computes the cycle net of a win with the backtest gross-return rule', () => {
    // s * (c - 1) - L: 1,600,000 * 1 - 1,550,000 = 50,000 (₦500 after five losses at 2.00x).
    expect(cycleNetAfterWinMinor(1_600_000, 200, 1_550_000)).toBe(50_000);
    // Non-integral s * c: floor(333 * 1.55) = 516, so 516 - 333 - 100 = 83.
    expect(cycleNetAfterWinMinor(333, 155, 100)).toBe(83);
    // A low target can leave a cycle negative even after a win.
    expect(cycleNetAfterWinMinor(400_000, 150, 350_000)).toBe(-150_000);
    expect(() => cycleNetAfterWinMinor(0, 200, 0)).toThrow(RangeError);
    expect(() => cycleNetAfterWinMinor(100, 100, 0)).toThrow(RangeError);
    expect(() => cycleNetAfterWinMinor(100, 200, -1)).toThrow(RangeError);
  });
});

describe('state integrity', () => {
  it('serializes and parses back unchanged at every stage', () => {
    const config = martingale();
    const states: ProgressionState[] = [createProgressionState(config)];
    const decision = decideNextStake(config, states[0], { availableBankrollMinor: BIG_BANKROLL });
    states.push(decision.state);
    if (decision.kind !== 'stake') throw new Error('expected stake');
    states.push(resolveStake(config, decision.state, { decisionId: 0, outcome: 'loss' }).state);
    states.push(stakesUntilStop(config).decision.state);
    for (const state of states) {
      expect(parseProgressionState(config, JSON.parse(JSON.stringify(state)))).toEqual(state);
    }
  });

  it('never mutates its inputs', () => {
    const config = deepFreeze(martingale());
    const state = deepFreeze(createProgressionState(config));
    const decision = decideNextStake(
      config,
      state,
      deepFreeze({ availableBankrollMinor: BIG_BANKROLL }),
    );
    if (decision.kind !== 'stake') throw new Error('expected stake');
    deepFreeze(decision);
    const resolved = resolveStake(
      config,
      decision.state,
      deepFreeze({ decisionId: 0, outcome: 'loss' }),
    );
    expect(state).toMatchObject({ status: 'ready', step: 0 });
    expect(decision.state).toMatchObject({ status: 'awaiting_result', step: 0 });
    expect(resolved.state).toMatchObject({ status: 'ready', step: 1 });
  });

  it('rejects malformed and inconsistent states without repairing them', () => {
    const config = martingale();
    const good = play(config, createProgressionState(config), 'loss').state; // step 1, loss 50,000
    const cases: [string, unknown][] = [
      ['unknown field', { ...good, extra: 1 }],
      ['negative step', { ...good, step: -1 }],
      ['fractional loss', { ...good, cycleLossMinor: 1.5 }],
      ['wrong loss total', { ...good, cycleLossMinor: 49_999 }],
      ['unknown status', { ...good, status: 'paused' }],
      ['step beyond the limit', { ...good, step: 7 }],
      ['more wins than results', { ...good, cyclesCompleted: 5 }],
      [
        'pending decision while ready',
        { ...good, pendingDecision: { decisionId: 1, stakeMinor: 100_000 } },
      ],
      ['awaiting without a decision', { ...good, status: 'awaiting_result' }],
      [
        'awaiting with the wrong stake',
        {
          ...good,
          status: 'awaiting_result',
          pendingDecision: { decisionId: 1, stakeMinor: 99_999 },
        },
      ],
      [
        'awaiting with the wrong id',
        {
          ...good,
          status: 'awaiting_result',
          pendingDecision: { decisionId: 0, stakeMinor: 100_000 },
        },
      ],
      [
        'blocked by a cap that does not apply',
        { ...good, status: 'blocked', blockReason: 'max_stake_exceeded' },
      ],
      ['exhausted outside a custom sequence', { ...good, status: 'exhausted' }],
      ['not an object', 'state'],
    ];
    for (const [name, state] of cases) {
      expect(
        errorCode(() => decideNextStake(config, state, { availableBankrollMinor: BIG_BANKROLL })),
        name,
      ).toBe('invalid_state');
    }
  });

  it('rejects a state under a different configuration', () => {
    const state = createProgressionState(martingale());
    expect(
      errorCode(() =>
        decideNextStake(martingale({ maxSteps: 5 }), state, { availableBankrollMinor: 1 }),
      ),
    ).toBe('config_mismatch');
    expect(errorCode(() => decideNextStake(fixed(), state, { availableBankrollMinor: 1 }))).toBe(
      'config_mismatch',
    );
  });

  it('binds each result to its decision: no double, stale, foreign or missing resolution', () => {
    const config = martingale();
    const first = decideNextStake(config, createProgressionState(config), {
      availableBankrollMinor: BIG_BANKROLL,
    });
    if (first.kind !== 'stake') throw new Error('expected stake');
    // No result without a decision.
    expect(
      errorCode(() =>
        resolveStake(config, createProgressionState(config), { decisionId: 0, outcome: 'win' }),
      ),
    ).toBe('no_pending_decision');
    // Wrong id.
    expect(
      errorCode(() => resolveStake(config, first.state, { decisionId: 1, outcome: 'win' })),
    ).toBe('decision_mismatch');
    // A second decision cannot be made before the first is resolved.
    expect(
      errorCode(() =>
        decideNextStake(config, first.state, { availableBankrollMinor: BIG_BANKROLL }),
      ),
    ).toBe('decision_pending');
    const resolved = resolveStake(config, first.state, { decisionId: 0, outcome: 'loss' });
    // Resolving the same decision again fails, against the new state...
    expect(
      errorCode(() => resolveStake(config, resolved.state, { decisionId: 0, outcome: 'win' })),
    ).toBe('no_pending_decision');
    // ...and a stale id cannot resolve a later decision.
    const second = decideNextStake(config, resolved.state, {
      availableBankrollMinor: BIG_BANKROLL,
    });
    if (second.kind !== 'stake') throw new Error('expected stake');
    expect(second.decisionId).toBe(1);
    expect(
      errorCode(() => resolveStake(config, second.state, { decisionId: 0, outcome: 'win' })),
    ).toBe('decision_mismatch');
    // A decision issued under one configuration cannot be resolved under another.
    expect(
      errorCode(() => resolveStake(capped(), second.state, { decisionId: 1, outcome: 'win' })),
    ).toBe('config_mismatch');
    // Invalid outcomes are rejected.
    expect(
      errorCode(() =>
        resolveStake(config, second.state, { decisionId: 1, outcome: 'push' as never }),
      ),
    ).toBe('invalid_input');
  });

  it('gives identical outputs for identical inputs', () => {
    const run = () => {
      const config = martingale();
      let state = createProgressionState(config);
      const decisions: ProgressionDecision[] = [];
      for (const outcome of ['loss', 'loss', 'win', 'loss', 'win'] as const) {
        const r = play(config, state, outcome);
        decisions.push(r.decision);
        state = r.state;
      }
      return { decisions, state };
    };
    expect(run()).toEqual(run());
  });
});

describe('invariants over seeded random sequences', () => {
  function lcg(seed: number) {
    let s = seed >>> 0;
    return (n: number) => {
      s = (Math.imul(s, 1_103_515_245) + 12_345) >>> 0;
      return s % n;
    };
  }

  function randomConfig(r: (n: number) => number): ProgressionConfig {
    const base = 1 + r(5_000);
    switch (r(4)) {
      case 0:
        return parseProgressionConfig({
          schemaVersion: 1,
          currency: 'NGN',
          winResetPolicy: 'reset_to_base',
          mode: 'fixed',
          baseStakeMinor: base,
          limits: {
            maxSteps: 1 + r(20),
            maxStakeMinor: r(2) ? null : base + r(1_000),
            maxCycleExposureMinor: r(2) ? null : base * (1 + r(10)),
          },
        });
      case 1:
        return parseProgressionConfig({
          schemaVersion: 1,
          currency: 'NGN',
          winResetPolicy: 'reset_to_base',
          mode: 'martingale',
          baseStakeMinor: base,
          multiplierX100: 101 + r(400),
          limits: {
            maxSteps: 1 + r(30),
            maxStakeMinor: r(2) ? null : base * (1 + r(50)),
            maxCycleExposureMinor: base * (1 + r(200)),
          },
        });
      case 2:
        return parseProgressionConfig({
          schemaVersion: 1,
          currency: 'NGN',
          winResetPolicy: 'reset_to_base',
          mode: 'capped_martingale',
          baseStakeMinor: base,
          multiplierX100: 101 + r(899),
          limits: {
            maxSteps: 1 + r(1_000),
            maxStakeMinor: base * (1 + r(100)),
            maxCycleExposureMinor: r(2) ? null : base * (1 + r(300)),
          },
        });
      default:
        return custom(Array.from({ length: 1 + r(12) }, () => 1 + r(10_000)));
    }
  }

  it('keeps every allowed stake positive, capped and funded, losses non-negative, and replays deterministically', () => {
    const r = lcg(20_261_013);
    for (let trial = 0; trial < 300; trial++) {
      const config = randomConfig(r);
      const outcomes = Array.from(
        { length: 60 },
        () => (r(3) === 0 ? 'win' : 'loss') as ProgressionOutcome,
      );
      const bankrolls = outcomes.map(() => r(100_000_000));
      const replay = () => {
        let state = createProgressionState(config);
        const log: unknown[] = [];
        for (const [i, outcome] of outcomes.entries()) {
          const decision = decideNextStake(config, state, {
            availableBankrollMinor: bankrolls[i]!,
          });
          log.push(decision);
          if (decision.kind !== 'stake') {
            expect(
              decideNextStake(config, decision.state, { availableBankrollMinor: BIG_BANKROLL }),
            ).toEqual(decision);
            state = decision.state;
            break;
          }
          expect(Number.isSafeInteger(decision.stakeMinor) && decision.stakeMinor > 0).toBe(true);
          expect(decision.stakeMinor).toBeLessThanOrEqual(bankrolls[i]!);
          if (config.limits.maxStakeMinor !== null) {
            expect(decision.stakeMinor).toBeLessThanOrEqual(config.limits.maxStakeMinor);
          }
          if (config.limits.maxCycleExposureMinor !== null) {
            expect(decision.exposureIfLostMinor).toBeLessThanOrEqual(
              config.limits.maxCycleExposureMinor,
            );
          }
          const resolution = resolveStake(config, decision.state, {
            decisionId: decision.decisionId,
            outcome,
          });
          expect(resolution.cycleLossAfterMinor).toBeGreaterThanOrEqual(0);
          if (outcome === 'win') {
            expect(resolution.state).toMatchObject({ step: 0, cycleLossMinor: 0 });
          }
          state = parseProgressionState(config, JSON.parse(JSON.stringify(resolution.state)));
          log.push(resolution);
        }
        return { log, state };
      };
      expect(replay()).toEqual(replay());
    }
  });
});
