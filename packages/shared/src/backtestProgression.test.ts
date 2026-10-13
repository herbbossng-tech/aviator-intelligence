import { describe, expect, it } from 'vitest';
import { backtestRequestSchema, runBacktest, type BacktestRound } from './backtest.js';
import type { TwoLegStrategyConfig } from './legs.js';
import {
  createProgressionState,
  createProgressionStepper,
  decideNextStake,
  parseProgressionConfig,
  parseProgressionState,
  resolveStake,
  type ProgressionConfig,
  type ProgressionOutcome,
} from './progression.js';
import type { SimulationSettings } from './simulation.js';
import type { StakingPlan } from './staking.js';

// SYNTHETIC TEST FIXTURES: invented multipliers and times. Arithmetic only; no configuration
// here is a recommendation, and no backtest result is evidence about future rounds.

function rounds(multipliersX100: readonly number[]): BacktestRound[] {
  return multipliersX100.map((m, i) => ({
    roundId: i + 1,
    multiplierX100: m,
    eventAt: new Date(Date.UTC(2026, 0, 1) + i * 1_000).toISOString(),
  }));
}

function strategy(
  a: Partial<TwoLegStrategyConfig['legs']['A']> = {},
  b: Partial<TwoLegStrategyConfig['legs']['B']> = {},
): TwoLegStrategyConfig {
  return {
    schemaVersion: 1,
    currency: 'NGN',
    legs: {
      A: { label: 'A', enabled: true, stakeMinor: 50_000, cashoutTargetX100: 200, ...a },
      B: { label: 'B', enabled: true, stakeMinor: 50_000, cashoutTargetX100: 500, ...b },
    },
  };
}

function settings(
  overrides: Partial<Omit<SimulationSettings, 'risk'>> = {},
  risk: Partial<SimulationSettings['risk']> = {},
): SimulationSettings {
  return {
    schemaVersion: 1,
    currency: 'NGN',
    startingBankrollMinor: 10_000_000,
    insufficientBankrollPolicy: 'skip_leg',
    ...overrides,
    risk: {
      stopBelowBankrollMinor: null,
      stopAtOrAboveBankrollMinor: null,
      maxDrawdownBps: null,
      maxRounds: null,
      ...risk,
    },
  };
}

function martingale(base = 50_000, limits: Record<string, unknown> = {}): ProgressionConfig {
  return parseProgressionConfig({
    schemaVersion: 1,
    currency: 'NGN',
    winResetPolicy: 'reset_to_base',
    mode: 'martingale',
    baseStakeMinor: base,
    multiplierX100: 200,
    limits: { maxSteps: 10, maxStakeMinor: null, maxCycleExposureMinor: 100_000_000, ...limits },
  });
}

function capped(base = 50_000, limits: Record<string, unknown> = {}): ProgressionConfig {
  return parseProgressionConfig({
    schemaVersion: 1,
    currency: 'NGN',
    winResetPolicy: 'reset_to_base',
    mode: 'capped_martingale',
    baseStakeMinor: base,
    multiplierX100: 200,
    limits: { maxSteps: 10, maxStakeMinor: 1_000_000, maxCycleExposureMinor: null, ...limits },
  });
}

function fixed(base = 50_000, maxSteps = 1_000): ProgressionConfig {
  return parseProgressionConfig({
    schemaVersion: 1,
    currency: 'NGN',
    winResetPolicy: 'reset_to_base',
    mode: 'fixed',
    baseStakeMinor: base,
    limits: { maxSteps, maxStakeMinor: null, maxCycleExposureMinor: null },
  });
}

function custom(stakesMinor: number[]): ProgressionConfig {
  return parseProgressionConfig({
    schemaVersion: 1,
    currency: 'NGN',
    winResetPolicy: 'reset_to_base',
    mode: 'custom',
    stakesMinor,
    afterFinalStep: 'stop',
    limits: { maxStakeMinor: null, maxCycleExposureMinor: null },
  });
}

const plan = (A: ProgressionConfig | null, B: ProgressionConfig | null = null): StakingPlan => ({
  schemaVersion: 1,
  legs: { A, B },
});

const legEntry = (r: ReturnType<typeof runBacktest>, seq: number, leg: 'A' | 'B') =>
  r.rounds[seq]!.legs.find((l) => l.leg === leg);

describe('progression stepper', () => {
  it('follows decideNextStake/resolveStake exactly and produces valid states', () => {
    let seed = 7;
    const rand = (n: number) => {
      seed = (Math.imul(seed, 1_103_515_245) + 12_345) >>> 0;
      return seed % n;
    };
    const configs = [
      martingale(100, { maxSteps: 12, maxCycleExposureMinor: 300_000 }),
      capped(333, { maxStakeMinor: 20_000 }),
      fixed(700, 5),
      custom([100, 250, 600, 1_400]),
    ];
    for (const config of configs) {
      for (let trial = 0; trial < 40; trial++) {
        const stepper = createProgressionStepper(config);
        let slow = createProgressionState(config);
        let fast = stepper.initialState;
        expect(fast).toEqual(slow);
        for (let i = 0; i < 40; i++) {
          const outcome: ProgressionOutcome = rand(3) === 0 ? 'win' : 'loss';
          const decision = decideNextStake(config, slow, { availableBankrollMinor: 1e12 });
          const request = stepper.request(fast);
          if (decision.kind !== 'stake') {
            expect(request.kind).toBe(decision.kind);
            if (request.kind === 'stake') throw new Error('unreachable');
            expect(request.state).toEqual(decision.state);
            expect(parseProgressionState(config, request.state)).toEqual(request.state);
            break;
          }
          expect(request).toEqual({
            kind: 'stake',
            step: decision.step,
            stakeMinor: decision.stakeMinor,
            cycleLossBeforeMinor: decision.cycleLossBeforeMinor,
          });
          slow = resolveStake(config, decision.state, {
            decisionId: decision.decisionId,
            outcome,
          }).state;
          fast = stepper.settle(fast, outcome);
          expect(fast).toEqual(slow);
        }
      }
    }
  });

  it('refuses foreign states and settling a capped step', () => {
    const stepper = createProgressionStepper(capped(50_000, { maxSteps: 1 }));
    const other = createProgressionState(martingale());
    expect(() => stepper.request(other)).toThrow(/another configuration/);
    const afterLoss = stepper.settle(stepper.initialState, 'loss');
    expect(() => stepper.settle(afterLoss, 'loss')).toThrow(/No stake can be settled/);
  });
});

describe('staking plan validation', () => {
  it('requires the base stake to equal the leg stake, an enabled leg and the same currency', () => {
    expect(() =>
      runBacktest(rounds([150]), strategy(), settings(), plan(martingale(60_000))),
    ).toThrow(/must start at the leg's stake/);
    expect(() =>
      runBacktest(rounds([150]), strategy({}, { enabled: false }), settings(), plan(null, fixed())),
    ).toThrow(/disabled/);
    const usd = { ...martingale(), currency: 'USD' } as ProgressionConfig;
    expect(() => runBacktest(rounds([150]), strategy(), settings(), plan(usd))).toThrow(/currency/);
  });

  it('is validated by the request schema, defaulting to flat stakes', () => {
    const base = { strategy: strategy(), settings: settings(), dataset: { source: 's' } };
    expect(backtestRequestSchema.parse(base).staking).toBeNull();
    expect(
      backtestRequestSchema.parse({ ...base, staking: plan(martingale()) }).staking,
    ).not.toBeNull();
    for (const staking of [
      plan(martingale(1)),
      { schemaVersion: 2, legs: { A: null, B: null } },
      { schemaVersion: 1, legs: { A: null } },
      { schemaVersion: 1, legs: { A: null, B: null }, extra: 1 },
    ]) {
      expect(
        backtestRequestSchema.safeParse({ ...base, staking }).success,
        JSON.stringify(staking),
      ).toBe(false);
    }
  });
});

describe('progression legs in the backtest', () => {
  it('doubles leg A after each of its losses and resets it after a win (the ₦500 example)', () => {
    // Leg A targets 2.00x: 1.50x, 1.50x, 1.50x lose; 2.50x wins. Leg B (5.00x) is flat.
    const r = runBacktest(
      rounds([150, 150, 150, 250, 150]),
      strategy(),
      settings(),
      plan(martingale()),
    );
    expect(r.rounds.map((x) => legEntry(r, x.sequenceNo, 'A')!.stakeMinor)).toEqual([
      50_000, 100_000, 200_000, 400_000, 50_000,
    ]);
    expect(legEntry(r, 3, 'A')).toMatchObject({
      result: 'win',
      grossReturnMinor: 800_000,
      netMinor: 400_000,
      progression: {
        step: 3,
        requestedStakeMinor: 400_000,
        cycleLossBeforeMinor: 350_000,
        cycleLossAfterMinor: 0,
        skipReason: null,
        active: true,
      },
    });
    // Leg B has no progression: flat stake and no progression fields.
    expect(r.rounds.every((x) => legEntry(r, x.sequenceNo, 'B')!.stakeMinor === 50_000)).toBe(true);
    expect(legEntry(r, 0, 'B')!.progression).toBeUndefined();
    expect(r.summary.progression).toMatchObject({
      legs: {
        A: {
          mode: 'martingale',
          finalStatus: 'active',
          finalStep: 1,
          maxStepPlaced: 3,
          cyclesCompleted: 1,
        },
        B: null,
      },
      roundsWithoutStake: 0,
    });
  });

  it('keeps the two legs independent: each moves only on its own result', () => {
    // 3.00x: A (2.00x) wins, B (5.00x) loses. 6.00x: both win.
    const r = runBacktest(
      rounds([300, 300, 600, 150]),
      strategy(),
      settings(),
      plan(martingale(), martingale(50_000)),
    );
    const steps = (leg: 'A' | 'B') =>
      r.rounds.map((x) => legEntry(r, x.sequenceNo, leg)!.progression!.step);
    expect(steps('A')).toEqual([0, 0, 0, 0]);
    expect(steps('B')).toEqual([0, 1, 2, 0]);
    expect(legEntry(r, 2, 'B')).toMatchObject({ stakeMinor: 200_000, result: 'win' });
    expect(r.summary.progression!.legs.B).toMatchObject({ cyclesCompleted: 1, finalStep: 1 });
  });

  it("never lets one leg fund its stake from the other leg's same-round return", () => {
    // Bankroll 120,000. Round 0: A 50,000 and B 50,000 lose -> 20,000. Round 1 would need
    // A 100,000 or B 50,000; a 9.90x round would pay both, but stakes are funded only from the
    // bankroll at the start of the round, so the run stops before staking.
    const r = runBacktest(
      rounds([150, 990]),
      strategy(),
      settings({ startingBankrollMinor: 120_000 }),
      plan(martingale(), null),
    );
    // Round 1 stops before staking: the smallest requested stake (B's 50,000) exceeds 20,000.
    expect(r.summary).toMatchObject({ stopReason: 'bankroll_exhausted', roundsReplayed: 1 });
  });

  it('decides each stake before the round is settled (no look-ahead)', () => {
    const base = [150, 150, 250, 150, 150, 990, 120, 300];
    const s = plan(martingale(), capped(50_000, { maxStakeMinor: 400_000 }));
    const stakes = (ms: number[]) =>
      runBacktest(rounds(ms), strategy(), settings(), s).rounds.map((x) =>
        x.legs.map((l) => l.stakeMinor),
      );
    const reference = stakes(base);
    for (let i = 0; i < base.length; i++) {
      const changed = [...base];
      changed[i] = changed[i] === 990 ? 101 : 990;
      // Every stake up to and including round i is unchanged by round i's own multiplier.
      expect(stakes(changed).slice(0, i + 1)).toEqual(reference.slice(0, i + 1));
    }
  });

  it('gives identical results for identical inputs', () => {
    const args = [
      rounds([150, 990, 150, 150, 300]),
      strategy(),
      settings(),
      plan(martingale(), custom([50_000, 70_000])),
    ] as const;
    expect(JSON.stringify(runBacktest(...args))).toBe(JSON.stringify(runBacktest(...args)));
  });

  it('matches flat staking exactly when a fixed progression never reaches a limit', () => {
    const ms = [150, 990, 150, 150, 300, 101, 600, 120];
    const flat = runBacktest(rounds(ms), strategy(), settings());
    const prog = runBacktest(rounds(ms), strategy(), settings(), plan(fixed(), fixed()));
    const strip = (r: typeof prog) => ({
      rounds: r.rounds.map((x) => ({
        ...x,
        legs: x.legs.map(({ progression: _p, ...rest }) => rest),
      })),
      summary: { ...r.summary, progression: undefined },
    });
    expect(strip(prog)).toEqual({ ...flat, summary: { ...flat.summary, progression: undefined } });
  });
});

describe('bankroll policies with progressions', () => {
  it('skip_leg: an unfundable progression stake is skipped, not lost, and resumes at the same step', () => {
    // Bankroll 400,000. A: Martingale from 50,000 at 2.00x. B: flat 50,000 at 5.00x.
    const r = runBacktest(
      rounds([150, 150, 600, 150, 600, 150]),
      strategy(),
      settings({ startingBankrollMinor: 400_000 }),
      plan(martingale()),
    );
    const a = (i: number) => legEntry(r, i, 'A')!;
    // Round 0: 400k; A 50k + B 50k lose -> 300k. Round 1: A 100k + B 50k lose -> 150k.
    // Round 2: A requests 200k > 150k available: skipped (insufficient bankroll); B 50k at 6.00x
    // wins 250k gross -> 150k + 200k = 350k.
    expect(a(2)).toMatchObject({
      result: 'skipped',
      stakeMinor: 0,
      progression: {
        step: 2,
        requestedStakeMinor: 200_000,
        cycleLossBeforeMinor: 150_000,
        cycleLossAfterMinor: 150_000,
        skipReason: 'insufficient_bankroll',
        active: true,
      },
    });
    // Round 3: A resumes at the same step with the same requested stake (not reset, not lowered).
    expect(a(3)).toMatchObject({
      result: 'loss',
      stakeMinor: 200_000,
      progression: { step: 2, cycleLossBeforeMinor: 150_000, cycleLossAfterMinor: 350_000 },
    });
    // Round 3: 350k -> 100k. Rounds 4 and 5: A requests 400k (step 3) and is skipped again.
    expect([4, 5].map((i) => a(i).progression)).toEqual([
      expect.objectContaining({
        step: 3,
        requestedStakeMinor: 400_000,
        skipReason: 'insufficient_bankroll',
      }),
      expect.objectContaining({
        step: 3,
        requestedStakeMinor: 400_000,
        skipReason: 'insufficient_bankroll',
      }),
    ]);
    expect(r.summary.progression!.legs.A).toMatchObject({
      skippedInsufficientBankroll: 3,
      skippedInactive: 0,
      finalStatus: 'active',
    });
  });

  it('stop_run: stops when the requested stakes cannot all be funded', () => {
    const r = runBacktest(
      rounds([150, 150, 150]),
      strategy(),
      settings({ startingBankrollMinor: 300_000, insufficientBankrollPolicy: 'stop_run' }),
      plan(martingale()),
    );
    // 300k -> 200k (A 50k + B 50k) -> 50k (A 100k + B 50k); round 2 needs 200k + 50k.
    expect(r.summary).toMatchObject({ stopReason: 'insufficient_bankroll', roundsReplayed: 2 });
    expect(r.summary.progression!.legs.A).toMatchObject({ finalStatus: 'active', finalStep: 2 });
  });

  it('bankroll_exhausted uses the smallest stake requested this round', () => {
    const r = runBacktest(
      rounds([150, 150, 150]),
      strategy({}, { enabled: false }),
      settings({ startingBankrollMinor: 160_000 }),
      plan(martingale()),
    );
    // 160k -> 110k -> 10k; A then requests 200k > 10k with no other leg.
    expect(r.summary).toMatchObject({ stopReason: 'bankroll_exhausted', roundsReplayed: 2 });
  });
});

describe('permanent progression limits in the backtest', () => {
  it('makes a capped leg inactive for the rest of the run while the other leg continues', () => {
    const r = runBacktest(
      rounds([150, 150, 600, 600, 150, 600]),
      strategy(),
      settings(),
      plan(capped(50_000, { maxSteps: 2 })),
    );
    const a = (i: number) => legEntry(r, i, 'A')!;
    expect([0, 1].map((i) => a(i).stakeMinor)).toEqual([50_000, 100_000]);
    for (const i of [2, 3, 4, 5]) {
      // Never restarts, even after leg B wins or the bankroll grows.
      expect(a(i)).toMatchObject({
        result: 'skipped',
        stakeMinor: 0,
        progression: {
          step: 2,
          requestedStakeMinor: null,
          skipReason: 'max_steps_reached',
          active: false,
        },
      });
      expect(legEntry(r, i, 'B')!.result).not.toBe('skipped');
    }
    expect(r.summary.progression!.legs.A).toMatchObject({
      finalStatus: 'blocked',
      finalBlockReason: 'max_steps_reached',
      skippedInactive: 4,
      inactiveFromSequenceNo: 2,
    });
    expect(r.summary.legs[0]!.skipped).toBe(4);
  });

  it('blocks on the maximum stake and on cycle exposure without lowering the stake', () => {
    const byStake = runBacktest(
      rounds([150, 150, 150, 150]),
      strategy({}, { enabled: false }),
      settings(),
      plan(capped(50_000, { maxStakeMinor: 150_000 })),
    );
    expect(legEntry(byStake, 2, 'A')!.progression).toMatchObject({
      skipReason: 'max_stake_exceeded',
      requestedStakeMinor: 200_000,
      active: false,
    });
    const byExposure = runBacktest(
      rounds([150, 150, 150, 150]),
      strategy({}, { enabled: false }),
      settings(),
      plan(martingale(50_000, { maxCycleExposureMinor: 300_000 })),
    );
    // 50k + 100k lost; 150k + 200k > 300k.
    expect(legEntry(byExposure, 2, 'A')!.progression).toMatchObject({
      skipReason: 'cycle_exposure_exceeded',
      requestedStakeMinor: 200_000,
      cycleLossBeforeMinor: 150_000,
    });
  });

  it('exhausts a custom sequence and, with every leg inactive, replays the rest without stakes', () => {
    const r = runBacktest(
      rounds([150, 150, 990, 990]),
      strategy({ stakeMinor: 1_000 }, { enabled: false }),
      settings(),
      plan(custom([1_000, 3_000])),
    );
    expect(legEntry(r, 2, 'A')!.progression).toMatchObject({
      step: 2,
      requestedStakeMinor: null,
      skipReason: 'sequence_exhausted',
      active: false,
    });
    expect(r.summary).toMatchObject({
      stopReason: 'completed_all_rounds',
      roundsReplayed: 4,
      roundsBreakEven: 2,
      endingBankrollMinor: 10_000_000 - 4_000,
    });
    expect(r.summary.progression).toMatchObject({
      roundsWithoutStake: 2,
      legs: {
        A: {
          finalStatus: 'exhausted',
          finalBlockReason: 'sequence_exhausted',
          finalCycleLossMinor: 4_000,
        },
      },
    });
  });

  it('keeps session stops in force over progressions', () => {
    const r = runBacktest(
      rounds([150, 150, 150, 150, 150]),
      strategy(),
      settings({}, { stopBelowBankrollMinor: 9_700_000, maxRounds: 4 }),
      plan(martingale(), martingale()),
    );
    // 10m -> 9.9m -> 9.7m -> 9.3m (< 9.7m): stop_below after round 2.
    expect(r.summary).toMatchObject({ stopReason: 'stop_below', roundsReplayed: 3 });
  });
});

describe('invariants over seeded random progression runs', () => {
  it('stakes within caps and the start-of-round bankroll, skips without losses, exact reconciliation', () => {
    let seed = 99;
    const rand = (n: number) => {
      seed = (Math.imul(seed, 1_103_515_245) + 12_345) >>> 0;
      return seed % n;
    };
    const randomProgression = (base: number): ProgressionConfig => {
      switch (rand(4)) {
        case 0:
          return fixed(base, 1 + rand(15));
        case 1:
          return martingale(base, {
            maxSteps: 1 + rand(12),
            maxCycleExposureMinor: base * (1 + rand(200)),
          });
        case 2:
          return capped(base, { maxSteps: 1 + rand(20), maxStakeMinor: base * (1 + rand(40)) });
        default:
          return custom([base, ...Array.from({ length: rand(6) }, () => 1 + rand(base * 4))]);
      }
    };
    for (let trial = 0; trial < 200; trial++) {
      const bankroll = 10_000 + rand(2_000_000);
      const s = strategy(
        { stakeMinor: 1 + rand(20_000), cashoutTargetX100: 101 + rand(400) },
        { stakeMinor: 1 + rand(20_000), cashoutTargetX100: 101 + rand(900), enabled: rand(4) > 0 },
      );
      const p = plan(
        rand(4) > 0 ? randomProgression(s.legs.A.stakeMinor) : null,
        s.legs.B.enabled && rand(3) > 0 ? randomProgression(s.legs.B.stakeMinor) : null,
      );
      const cfg = settings({
        startingBankrollMinor: bankroll,
        insufficientBankrollPolicy: rand(2) ? 'skip_leg' : 'stop_run',
      });
      const ms = Array.from(
        { length: 50 + rand(150) },
        () => [100, 101 + rand(200), 120 + rand(1_500)][rand(3)]!,
      );
      const r = runBacktest(rounds(ms), s, cfg, p);
      expect(runBacktest(rounds(ms), s, cfg, p)).toEqual(r);

      const lastLoss: Record<string, number> = { A: 0, B: 0 };
      let staked = 0;
      let returned = 0;
      for (const round of r.rounds) {
        let available = round.bankrollBeforeMinor;
        for (const e of round.legs) {
          staked += e.stakeMinor;
          returned += e.grossReturnMinor;
          expect(e.netMinor).toBe(e.grossReturnMinor - e.stakeMinor);
          if (e.result === 'skipped') {
            expect(e.stakeMinor).toBe(0);
          } else {
            expect(e.stakeMinor).toBeGreaterThan(0);
            expect(e.stakeMinor).toBeLessThanOrEqual(available);
            available -= e.stakeMinor;
          }
          const config = p.legs[e.leg];
          if (config === null) {
            expect(e.progression).toBeUndefined();
            continue;
          }
          const pr = e.progression!;
          expect(pr.cycleLossBeforeMinor).toBe(lastLoss[e.leg]);
          if (e.result === 'skipped') {
            expect(pr.cycleLossAfterMinor).toBe(pr.cycleLossBeforeMinor);
            expect(pr.skipReason).not.toBeNull();
          } else {
            expect(pr.requestedStakeMinor).toBe(e.stakeMinor);
            expect(pr.cycleLossAfterMinor).toBe(
              e.result === 'win' ? 0 : pr.cycleLossBeforeMinor + e.stakeMinor,
            );
            if (config.limits.maxStakeMinor !== null) {
              expect(e.stakeMinor).toBeLessThanOrEqual(config.limits.maxStakeMinor);
            }
            if (config.limits.maxCycleExposureMinor !== null) {
              expect(pr.cycleLossBeforeMinor + e.stakeMinor).toBeLessThanOrEqual(
                config.limits.maxCycleExposureMinor,
              );
            }
          }
          lastLoss[e.leg] = pr.cycleLossAfterMinor;
        }
        expect(round.bankrollAfterMinor).toBe(round.bankrollBeforeMinor + round.roundNetMinor);
      }
      expect(r.summary.totalStakedMinor).toBe(staked);
      expect(r.summary.totalReturnedMinor).toBe(returned);
      expect(r.summary.endingBankrollMinor - r.summary.startingBankrollMinor).toBe(
        returned - staked,
      );
      for (const key of ['A', 'B'] as const) {
        const prog = r.summary.progression!.legs[key];
        if (prog) expect(prog.finalCycleLossMinor).toBe(lastLoss[key]);
      }
    }
  });
});
