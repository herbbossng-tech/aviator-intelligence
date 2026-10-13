import { describe, expect, it } from 'vitest';
import { createSummaryReplayer, runBacktest, type BacktestRound } from './backtest.js';
import { pathGenerator, runBootstrap } from './bootstrap.js';
import type { TwoLegStrategyConfig } from './legs.js';
import {
  parseProgressionConfig,
  progressionConfigKey,
  type ProgressionConfig,
} from './progression.js';
import {
  partitionChronological,
  runBlockRobustness,
  verifyBlockRobustnessResult,
  RobustnessResultError,
} from './robustness.js';
import type { SimulationSettings } from './simulation.js';
import type { StakingPlan } from './staking.js';

// SYNTHETIC TEST FIXTURES: invented multipliers and times. Arithmetic only; no configuration
// here is a recommendation, and no result is evidence about future rounds. Virtual money only.

function rounds(multipliersX100: readonly number[]): BacktestRound[] {
  return multipliersX100.map((m, i) => ({
    roundId: i + 1,
    multiplierX100: m,
    eventAt: new Date(Date.UTC(2026, 0, 1) + i * 1_000).toISOString(),
  }));
}

/** Deterministic pseudo-random multipliers (mostly low, occasionally high). */
function pseudoMultipliers(count: number, seed: number): number[] {
  let state = seed >>> 0;
  const out: number[] = [];
  for (let i = 0; i < count; i++) {
    state = (Math.imul(state, 1_103_515_245) + 12_345) >>> 0;
    const r = state % 1_000;
    out.push(r < 60 ? 100 : r < 900 ? 100 + (r % 300) : 400 + (r % 600) * 10);
  }
  return out;
}

const STRATEGY: TwoLegStrategyConfig = {
  schemaVersion: 1,
  currency: 'NGN',
  legs: {
    A: { label: 'A', enabled: true, stakeMinor: 1_000, cashoutTargetX100: 200 },
    B: { label: 'B', enabled: true, stakeMinor: 1_000, cashoutTargetX100: 500 },
  },
};

function settings(
  startingBankrollMinor = 200_000,
  risk: Partial<SimulationSettings['risk']> = {},
  policy: SimulationSettings['insufficientBankrollPolicy'] = 'skip_leg',
): SimulationSettings {
  return {
    schemaVersion: 1,
    currency: 'NGN',
    startingBankrollMinor,
    insufficientBankrollPolicy: policy,
    risk: {
      stopBelowBankrollMinor: null,
      stopAtOrAboveBankrollMinor: null,
      maxDrawdownBps: null,
      maxRounds: null,
      ...risk,
    },
  };
}

const martingale = (multiplierX100 = 200, maxSteps = 6, exposure = 10_000_000) =>
  parseProgressionConfig({
    schemaVersion: 1,
    currency: 'NGN',
    winResetPolicy: 'reset_to_base',
    mode: 'martingale',
    baseStakeMinor: 1_000,
    multiplierX100,
    limits: { maxSteps, maxStakeMinor: null, maxCycleExposureMinor: exposure },
  });
const custom = (stakes: number[]) =>
  parseProgressionConfig({
    schemaVersion: 1,
    currency: 'NGN',
    winResetPolicy: 'reset_to_base',
    mode: 'custom',
    stakesMinor: stakes,
    afterFinalStep: 'stop',
    limits: { maxStakeMinor: null, maxCycleExposureMinor: null },
  });
const plan = (A: StakingPlan['legs']['A'], B: StakingPlan['legs']['B'] = null): StakingPlan => ({
  schemaVersion: 1,
  legs: { A, B },
});

/** The multipliers bootstrap path p draws, reconstructed from the documented rules. */
function drawnPath(sample: readonly number[], seed: number, p: number): number[] {
  const rng = pathGenerator(seed, p);
  return sample.map(() => sample[rng.nextIndex(sample.length)]!);
}

const sorted = (values: number[]) => [...values].sort((a, b) => a - b);

describe('staking-aware summary replay', () => {
  it('equals the canonical backtest summary for seeded random plans and data', () => {
    for (let seed = 1; seed <= 120; seed++) {
      const ms = pseudoMultipliers(40 + (seed % 60), seed);
      const staking = plan(
        seed % 3 === 0 ? null : martingale(150 + (seed % 7) * 25, 1 + (seed % 8)),
        seed % 2 === 0 ? custom([1_000, 2_500, 6_000].slice(0, 1 + (seed % 3))) : null,
      );
      const s = settings(5_000 + seed * 900, {}, seed % 5 === 0 ? 'stop_run' : 'skip_leg');
      const replay = createSummaryReplayer(STRATEGY, s, staking);
      expect(replay(ms)).toEqual(runBacktest(rounds(ms), STRATEGY, s, staking).summary);
    }
  });

  it('starts every replay afresh: reusing a replayer never carries progression state', () => {
    const staking = plan(martingale(200, 4), custom([1_000, 3_000]));
    const replay = createSummaryReplayer(STRATEGY, settings(), staking);
    const losing = [150, 150, 150]; // leaves both legs deep in a losing cycle
    const later = pseudoMultipliers(50, 7);
    replay(losing);
    expect(replay(later)).toEqual(createSummaryReplayer(STRATEGY, settings(), staking)(later));
    expect(replay(later)).toEqual(
      runBacktest(rounds(later), STRATEGY, settings(), staking).summary,
    );
  });

  it('rejects a plan that does not fit the strategy instead of replaying flat stakes', () => {
    const wrongBase = plan({ ...martingale(), baseStakeMinor: 2_000 } as ProgressionConfig);
    expect(() => createSummaryReplayer(STRATEGY, settings(), wrongBase)).toThrow(/leg's stake/);
    const disabled = {
      ...STRATEGY,
      legs: { ...STRATEGY.legs, B: { ...STRATEGY.legs.B, enabled: false } },
    };
    expect(() => createSummaryReplayer(disabled, settings(), plan(null, custom([1_000])))).toThrow(
      /disabled/,
    );
  });
});

describe('progression-aware bootstrap', () => {
  const sample = pseudoMultipliers(60, 11);
  const observed = (s: SimulationSettings, staking: StakingPlan | null) =>
    runBacktest(rounds(sample), STRATEGY, s, staking).summary;

  it('leaves flat-stake results exactly as before (no staking metadata)', () => {
    const s = settings();
    const flat = runBootstrap(sample, STRATEGY, s, { paths: 40, seed: 5 }, observed(s, null));
    expect(
      runBootstrap(sample, STRATEGY, s, { paths: 40, seed: 5 }, observed(s, null), null),
    ).toEqual(flat);
    expect('staking' in flat).toBe(false);
  });

  it('replays every path from a fresh progression state, exactly as an independent backtest', () => {
    const staking = plan(martingale(200, 3, 6_000), custom([1_000, 4_000]));
    // A tight bankroll so that limits, bankroll skips and stops all occur on some paths.
    const s = settings(5_500, { stopBelowBankrollMinor: 500 });
    const paths = 64;
    const seed = 424_242;
    const result = runBootstrap(
      sample,
      STRATEGY,
      s,
      { paths, seed },
      observed(s, staking),
      staking,
    );

    const perPath = Array.from(
      { length: paths },
      (_, p) => runBacktest(rounds(drawnPath(sample, seed, p)), STRATEGY, s, staking).summary,
    );
    const endings = sorted(perPath.map((x) => x.endingBankrollMinor));
    expect(result.endingBankrollMinor.min).toBe(endings[0]);
    expect(result.endingBankrollMinor.max).toBe(endings.at(-1));
    expect(result.endingBankrollMinor.quantiles.find((q) => q.levelBps === 5000)!.value).toBe(
      endings[Math.ceil(0.5 * paths) - 1],
    );
    for (const reason of Object.keys(result.stopReasons) as (keyof typeof result.stopReasons)[]) {
      expect(result.stopReasons[reason]).toBe(
        perPath.filter((x) => x.stopReason === reason).length,
      );
    }

    expect(result.staking?.statePolicy).toBe('reset_each_path');
    for (const key of ['A', 'B'] as const) {
      const leg = result.staking!.legs[key]!;
      expect(leg.configKey).toBe(progressionConfigKey(staking.legs[key]));
      expect(leg.mode).toBe(staking.legs[key]!.mode);
      expect(leg.denominator).toBe(paths);
      expect(leg.pathsStoppedByLimit).toBe(
        perPath.filter((x) => x.progression!.legs[key]!.finalStatus !== 'active').length,
      );
      expect(leg.pathsWithBankrollSkips).toBe(
        perPath.filter((x) => x.progression!.legs[key]!.skippedInsufficientBankroll > 0).length,
      );
    }
    // The fixture exercises permanent stops and bankroll skips (not vacuous).
    expect(result.staking!.legs.A!.pathsStoppedByLimit).toBeGreaterThan(0);
    expect(
      result.staking!.legs.A!.pathsWithBankrollSkips +
        result.staking!.legs.B!.pathsWithBankrollSkips,
    ).toBeGreaterThan(0);
  });

  it('uses the same draws as a flat analysis: only the stakes differ', () => {
    const s = settings();
    const staking = plan(martingale());
    const a = runBootstrap(sample, STRATEGY, s, { paths: 20, seed: 9 }, observed(s, null));
    const b = runBootstrap(
      sample,
      STRATEGY,
      s,
      { paths: 20, seed: 9 },
      observed(s, staking),
      staking,
    );
    expect(b.sample).toEqual(a.sample);
    expect(b.pathLength).toBe(a.pathLength);
    expect(b.endingBankrollMinor).not.toEqual(a.endingBankrollMinor);
  });

  it('is deterministic for the same seed, plan and sample', () => {
    const s = settings(20_000);
    const staking = plan(martingale(250, 5), custom([1_000, 2_000, 4_000]));
    const run = () =>
      runBootstrap(sample, STRATEGY, s, { paths: 50, seed: 77 }, observed(s, staking), staking);
    expect(run()).toEqual(run());
    expect(
      runBootstrap(sample, STRATEGY, s, { paths: 50, seed: 78 }, observed(s, staking), staking),
    ).not.toEqual(run());
  });

  it('identifies different plans distinctly', () => {
    const s = settings();
    const p1 = plan(martingale(200));
    const p2 = plan(martingale(300));
    const r1 = runBootstrap(sample, STRATEGY, s, { paths: 10, seed: 1 }, observed(s, p1), p1);
    const r2 = runBootstrap(sample, STRATEGY, s, { paths: 10, seed: 1 }, observed(s, p2), p2);
    expect(r1.staking!.legs.A!.configKey).not.toBe(r2.staking!.legs.A!.configKey);
    expect(r1.staking!.legs.B).toBeNull();
  });
});

describe('progression-aware chronological robustness', () => {
  const ms = pseudoMultipliers(150, 3);
  const sample = rounds(ms);
  const staking = plan(martingale(200, 4, 20_000), custom([1_000, 3_000, 9_000]));
  const s = settings(30_000);

  it('replays the full sample and each block exactly as independent backtests', () => {
    const result = runBlockRobustness(sample, STRATEGY, s, { windows: 3 }, staking);
    expect(result.full.summary).toEqual(runBacktest(sample, STRATEGY, s, staking).summary);
    for (const block of result.blocks) {
      const slice = sample.slice(block.startIndex, block.endIndex);
      expect(block.summary).toEqual(runBacktest(slice, STRATEGY, s, staking).summary);
    }
    expect(result.staking).toEqual({
      statePolicy: 'reset_each_block',
      legs: {
        A: { mode: 'martingale', configKey: progressionConfigKey(staking.legs.A) },
        B: { mode: 'custom', configKey: progressionConfigKey(staking.legs.B) },
      },
    });
  });

  it('resets progression state at each block boundary rather than carrying it forward', () => {
    // Block 1 ends on three losses for leg A (a Martingale), so carried state would make
    // block 2 open at step 3; reset state opens it at the base stake.
    const pre = [...pseudoMultipliers(27, 5), 150, 150, 150];
    const post = [120, ...pseudoMultipliers(29, 6)];
    const r = rounds([...pre, ...post]);
    const onlyA = plan(martingale(200, 8));
    const result = runBlockRobustness(r, STRATEGY, settings(), { windows: 2 }, onlyA);
    expect(partitionChronological(60, 2).map((b) => b.roundCount)).toEqual([30, 30]);
    const second = result.blocks[1]!.summary;
    const fresh = runBacktest(rounds(post), STRATEGY, settings(), onlyA);
    expect(second).toEqual(fresh.summary);
    expect(fresh.rounds[0]!.legs[0]!.stakeMinor).toBe(1_000);
    expect(fresh.rounds[0]!.legs[0]!.progression!.step).toBe(0);
    // The full-sample replay, by contrast, is mid-cycle at that point.
    const full = runBacktest(r, STRATEGY, settings(), onlyA);
    expect(full.rounds[30]!.legs[0]!.progression!.step).toBeGreaterThan(0);
  });

  it('leaves flat-stake results exactly as before', () => {
    const flat = runBlockRobustness(sample, STRATEGY, s, { windows: 3 });
    expect(runBlockRobustness(sample, STRATEGY, s, { windows: 3 }, null)).toEqual(flat);
    expect('staking' in flat).toBe(false);
  });

  it('verifies stored progression results against the plan, and rejects mismatches', () => {
    const result = runBlockRobustness(sample, STRATEGY, s, { windows: 3 }, staking);
    const base = { windows: 3, sampleSize: 150, strategy: STRATEGY, settings: s };
    const json = () => JSON.parse(JSON.stringify(result)) as typeof result;
    expect(
      verifyBlockRobustnessResult(json(), {
        ...base,
        staking,
        observedSummary: runBacktest(sample, STRATEGY, s, staking).summary,
      }),
    ).toEqual(result);

    // Verified as if the run were flat.
    expect(() => verifyBlockRobustnessResult(json(), base)).toThrow(RobustnessResultError);
    // A different plan than the one replayed.
    expect(() =>
      verifyBlockRobustnessResult(json(), {
        ...base,
        staking: plan(martingale(300, 4, 20_000), staking.legs.B),
      }),
    ).toThrow(/does not identify|does not match the plan/);
    // Metadata removed.
    const noMeta = json();
    delete noMeta.staking;
    expect(() => verifyBlockRobustnessResult(noMeta, { ...base, staking })).toThrow(
      /staking metadata does not match/,
    );
    // A block's progression skips no longer reconcile with its leg totals.
    const tampered = json();
    tampered.blocks[1]!.summary.progression!.legs.A!.skippedInactive += 1;
    expect(() => verifyBlockRobustnessResult(tampered, { ...base, staking })).toThrow(
      /progression skips do not add up/,
    );
    // A flat result checked against a progression plan.
    const flat = runBlockRobustness(sample, STRATEGY, s, { windows: 3 });
    expect(() => verifyBlockRobustnessResult(flat, { ...base, staking })).toThrow(
      RobustnessResultError,
    );
  });
});
