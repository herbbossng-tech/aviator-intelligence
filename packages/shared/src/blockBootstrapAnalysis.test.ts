import { describe, expect, it } from 'vitest';
import { ZodError } from 'zod';
import { runBacktest, type BacktestRound, type BacktestSummary } from './backtest.js';
import { BlockBootstrapError, gatherBlockPath, movingBlockPath } from './blockBootstrap.js';
import { blockBootstrapSummarySchema, runBlockBootstrap } from './blockBootstrapAnalysis.js';
import { AnalysisLimitError, nearestRankSorted, pathGenerator, runBootstrap } from './bootstrap.js';
import type { TwoLegStrategyConfig } from './legs.js';
import { parseProgressionConfig, progressionConfigKey } from './progression.js';
import type { SimulationSettings } from './simulation.js';
import type { StakingPlan } from './staking.js';

// SYNTHETIC TEST FIXTURES: invented multipliers and times, virtual money only. Arithmetic
// checks of the engine, not recommendations; no result is evidence about future rounds.

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
const ONLY_A: TwoLegStrategyConfig = {
  ...STRATEGY,
  legs: { ...STRATEGY.legs, B: { ...STRATEGY.legs.B, enabled: false } },
};

function settings(
  startingBankrollMinor = 200_000,
  risk: Partial<SimulationSettings['risk']> = {},
): SimulationSettings {
  return {
    schemaVersion: 1,
    currency: 'NGN',
    startingBankrollMinor,
    insufficientBankrollPolicy: 'skip_leg',
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

const observedOf = (
  sample: readonly number[],
  strategy: TwoLegStrategyConfig,
  s: SimulationSettings,
  staking: StakingPlan | null,
) => runBacktest(rounds(sample), strategy, s, staking).summary;

/** Path p, rebuilt independently from the step 1 sampler and replayed by runBacktest. */
function independentPath(
  sample: readonly number[],
  b: number,
  seed: number,
  p: number,
  strategy: TwoLegStrategyConfig,
  s: SimulationSettings,
  staking: StakingPlan | null,
) {
  const values = gatherBlockPath(sample, movingBlockPath(sample.length, b, seed, p).indices);
  return runBacktest(rounds(values), strategy, s, staking);
}

/** Longest run of consecutive rounds with a negative round net, from the round ledger. */
function referenceLongestLosingStreak(roundNets: readonly number[]): number {
  let longest = 0;
  let run = 0;
  for (const net of roundNets) {
    run = net < 0 ? run + 1 : 0;
    longest = Math.max(longest, run);
  }
  return longest;
}

function referenceDistribution(values: number[]) {
  const sorted = Float64Array.from(values).sort();
  return {
    min: sorted[0],
    max: sorted[sorted.length - 1],
    quantiles: [500, 2500, 5000, 7500, 9500].map((levelBps) => ({
      levelBps,
      value: nearestRankSorted(sorted, levelBps),
    })),
  };
}

describe('moving-block analysis: canonical replay', () => {
  const sample = pseudoMultipliers(120, 11);

  it('aggregates exactly what independent backtests of the same paths give', () => {
    const staking = plan(martingale(200, 3, 6_000), custom([1_000, 4_000]));
    // A tight bankroll so that limits, an exhausted sequence, bankroll skips and stops occur.
    const s = settings(5_500, { stopBelowBankrollMinor: 2_000 });
    const b = 6;
    const seed = 31_337;
    const paths = 60;
    const result = runBlockBootstrap(
      sample,
      STRATEGY,
      s,
      { paths, seed, blockLength: b },
      observedOf(sample, STRATEGY, s, staking),
      staking,
    );
    const replays = Array.from({ length: paths }, (_, p) =>
      independentPath(sample, b, seed, p, STRATEGY, s, staking),
    );
    const per = replays.map((r) => r.summary);

    expect(result.endingBankrollMinor).toEqual(
      referenceDistribution(per.map((x) => x.endingBankrollMinor)),
    );
    expect(result.maxDrawdownMinor).toEqual(
      referenceDistribution(per.map((x) => x.maxDrawdownMinor)),
    );
    expect(result.roundsReplayed).toEqual(referenceDistribution(per.map((x) => x.roundsReplayed)));
    // The streak, recomputed from each path's round-by-round nets, not from the summary.
    expect(result.longestLosingStreak).toEqual(
      referenceDistribution(
        replays.map((r) => referenceLongestLosingStreak(r.rounds.map((x) => x.roundNetMinor))),
      ),
    );
    for (const reason of Object.keys(result.stopReasons) as BacktestSummary['stopReason'][]) {
      expect(result.stopReasons[reason]).toBe(per.filter((x) => x.stopReason === reason).length);
    }
    expect(result.netOutcome).toEqual({
      positive: per.filter((x) => x.netProfitMinor > 0).length,
      zero: per.filter((x) => x.netProfitMinor === 0).length,
      negative: per.filter((x) => x.netProfitMinor < 0).length,
      denominator: paths,
    });
    expect(result.staking?.statePolicy).toBe('reset_each_path');
    for (const key of ['A', 'B'] as const) {
      const leg = result.staking!.legs[key]!;
      expect(leg.configKey).toBe(progressionConfigKey(staking.legs[key]));
      expect(leg.denominator).toBe(paths);
      expect(leg.pathsStoppedByLimit).toBe(
        per.filter((x) => x.progression!.legs[key]!.finalStatus !== 'active').length,
      );
      expect(leg.pathsWithBankrollSkips).toBe(
        per.filter((x) => x.progression!.legs[key]!.skippedInsufficientBankroll > 0).length,
      );
    }
    // Not vacuous: a Martingale limit, an exhausted custom sequence, bankroll skips and stops.
    expect(per.some((x) => x.progression!.legs.A!.finalStatus === 'blocked')).toBe(true);
    expect(per.some((x) => x.progression!.legs.B!.finalStatus === 'exhausted')).toBe(true);
    expect(
      result.staking!.legs.A!.pathsWithBankrollSkips +
        result.staking!.legs.B!.pathsWithBankrollSkips,
    ).toBeGreaterThan(0);
    expect(result.stopReasons.stop_below).toBeGreaterThan(0);
    expect(result.configuredBoundaries.lowerBankrollStop).toEqual({
      thresholdMinor: 2_000,
      count: result.stopReasons.stop_below,
      denominator: paths,
    });
  });

  it('does the same for flat stakes, with no staking block', () => {
    const s = settings(20_000);
    const result = runBlockBootstrap(
      sample,
      STRATEGY,
      s,
      { paths: 30, seed: 5, blockLength: 4 },
      observedOf(sample, STRATEGY, s, null),
    );
    expect('staking' in result).toBe(false);
    const per = Array.from(
      { length: 30 },
      (_, p) => independentPath(sample, 4, 5, p, STRATEGY, s, null).summary,
    );
    expect(result.endingBankrollMinor).toEqual(
      referenceDistribution(per.map((x) => x.endingBankrollMinor)),
    );
    expect(result.maxDrawdownFraction).toEqual(
      referenceDistribution(per.map((x) => x.maxDrawdownFraction)),
    );
  });

  it('replays full-length paths, documents its layout and matches the output schema', () => {
    const s = settings(10_000_000); // ample: no stop ends a path early
    const result = runBlockBootstrap(
      sample,
      STRATEGY,
      s,
      { paths: 25, seed: 9, blockLength: 7 },
      observedOf(sample, STRATEGY, s, null),
    );
    expect(result.pathLength).toBe(120);
    expect(result.roundsReplayed.min).toBe(120);
    expect(result.roundsReplayed.max).toBe(120);
    expect(result.resampling).toEqual({
      method: 'moving_block',
      blockLength: 7,
      blocksPerPath: 18, // ⌈120 / 7⌉
      lastBlockLength: 1, // 120 − 17 · 7
      candidateStarts: 114, // 120 − 7 + 1
    });
    expect(result.endingBankrollMinor.quantiles.map((q) => q.levelBps)).toEqual([
      500, 2500, 5000, 7500, 9500,
    ]);
    expect(blockBootstrapSummarySchema.parse(JSON.parse(JSON.stringify(result)))).toEqual(result);
  });

  it('never changes the sample it reads', () => {
    const frozen = Object.freeze([...sample]);
    const s = settings();
    expect(() =>
      runBlockBootstrap(
        frozen,
        STRATEGY,
        s,
        { paths: 5, seed: 1, blockLength: 3 },
        observedOf(sample, STRATEGY, s, null),
      ),
    ).not.toThrow();
    expect(frozen).toEqual(sample);
  });
});

describe('moving-block analysis: reproducibility and state', () => {
  const sample = pseudoMultipliers(150, 4);
  const staking = plan(martingale(250, 5, 50_000), custom([1_000, 2_000, 4_000]));
  const s = settings(30_000);
  const observed = observedOf(sample, STRATEGY, s, staking);
  const run = (seed: number, blockLength: number) =>
    runBlockBootstrap(sample, STRATEGY, s, { paths: 40, seed, blockLength }, observed, staking);

  it('is deterministic, and repeated or interleaved analyses never leak state', () => {
    const first = run(77, 5);
    run(78, 9); // another analysis in between
    runBootstrap(sample, STRATEGY, s, { paths: 10, seed: 77 }, observed, staking);
    expect(run(77, 5)).toEqual(first);
  });

  it('distinguishes seeds and block lengths', () => {
    const base = run(77, 5);
    expect(run(78, 5).endingBankrollMinor).not.toEqual(base.endingBankrollMinor);
    const other = run(77, 10);
    expect(other.resampling.blockLength).toBe(10);
    expect(other.endingBankrollMinor).not.toEqual(base.endingBankrollMinor);
  });

  it('does not reproduce the IID bootstrap for the same seed', () => {
    const iid = runBootstrap(sample, STRATEGY, s, { paths: 40, seed: 77 }, observed, staking);
    const block = run(77, 5);
    expect(block.algorithmVersion).not.toBe(iid.algorithmVersion);
    expect(block.endingBankrollMinor).not.toEqual(iid.endingBankrollMinor);
  });

  it("keeps each leg's progression independent of the other leg's staking", () => {
    // With an ample bankroll nothing is skipped, so a leg's progression can depend only on
    // its own results: leg A's limit counts must not change when leg B's staking changes.
    const ample = settings(100_000_000);
    const withB = plan(martingale(200, 3), custom([1_000, 3_000]));
    const flatB = plan(martingale(200, 3), null);
    const go = (p: StakingPlan) =>
      runBlockBootstrap(
        sample,
        STRATEGY,
        ample,
        { paths: 50, seed: 3, blockLength: 6 },
        observedOf(sample, STRATEGY, ample, p),
        p,
      );
    const a1 = go(withB).staking!.legs.A!;
    const a2 = go(flatB).staking!.legs.A!;
    expect(a1.pathsStoppedByLimit).toBe(a2.pathsStoppedByLimit);
    expect(a1.pathsStoppedByLimit).toBeGreaterThan(0);
    expect(a1.pathsWithBankrollSkips).toBe(0);
  });
});

describe('moving-block analysis: order-sensitive statistics', () => {
  // One enabled leg at 2.00x: 150 loses, 300 wins. Both samples hold 100 of each.
  const alternating = Array.from({ length: 200 }, (_, i) => (i % 2 === 0 ? 150 : 300));
  const clustered = [...new Array<number>(100).fill(150), ...new Array<number>(100).fill(300)];
  const s = settings(100_000_000);
  const analyse = (sample: number[], blockLength: number) =>
    runBlockBootstrap(
      sample,
      ONLY_A,
      s,
      { paths: 200, seed: 2_024, blockLength },
      observedOf(sample, ONLY_A, s, null),
    );

  it('keeps recorded order inside blocks: same values, different order, different streaks', () => {
    // Alternating stretches of 2 contain at most one loss; two can meet at a join, never three.
    expect(analyse(alternating, 2).longestLosingStreak.max).toBeLessThanOrEqual(2);
    // Clustered stretches of 20 are mostly all-loss or all-win, so long streaks are common.
    const clusteredStreaks = analyse(clustered, 20).longestLosingStreak;
    expect(clusteredStreaks.quantiles.find((q) => q.levelBps === 5000)!.value).toBeGreaterThan(20);
    // Shuffling destroys the alternation: IID paths (rebuilt from the documented IID draw
    // rule and replayed independently) contain losing streaks longer than 2.
    const iidStreaks = Array.from({ length: 200 }, (_, p) => {
      const rng = pathGenerator(2_024, p);
      const values = alternating.map(() => alternating[rng.nextIndex(alternating.length)]!);
      const r = runBacktest(rounds(values), ONLY_A, s);
      return referenceLongestLosingStreak(r.rounds.map((x) => x.roundNetMinor));
    });
    expect(Math.max(...iidStreaks)).toBeGreaterThan(2);
  });

  it('counts zero events with their denominators', () => {
    const allWins = new Array<number>(40).fill(1_000); // both legs win every round
    const staking = plan(martingale(200, 2), custom([1_000, 2_000]));
    const result = runBlockBootstrap(
      allWins,
      STRATEGY,
      s,
      { paths: 12, seed: 1, blockLength: 3 },
      observedOf(allWins, STRATEGY, s, staking),
      staking,
    );
    for (const key of ['A', 'B'] as const) {
      expect(result.staking!.legs[key]).toMatchObject({
        pathsStoppedByLimit: 0,
        pathsWithBankrollSkips: 0,
        denominator: 12,
      });
    }
    expect(result.netOutcome).toEqual({ positive: 12, zero: 0, negative: 0, denominator: 12 });
    expect(result.longestLosingStreak.max).toBe(0);
    expect(result.stopReasons.completed_all_rounds).toBe(12);
    expect(result.configuredBoundaries).toEqual({ lowerBankrollStop: null, maxDrawdownStop: null });
    expect(result.warnings.map((w) => w.code)).toEqual(
      expect.arrayContaining(['degenerate_sample', 'small_sample', 'few_candidate_blocks']),
    );
  });

  it('warns about few candidate stretches only below 100', () => {
    const big = pseudoMultipliers(400, 8);
    const warn = (sample: number[], blockLength: number) =>
      runBlockBootstrap(
        sample,
        ONLY_A,
        s,
        { paths: 200, seed: 1, blockLength },
        observedOf(sample, ONLY_A, s, null),
      ).warnings.map((w) => w.code);
    expect(warn(big, 40)).not.toContain('few_candidate_blocks'); // S = 361
    expect(warn(pseudoMultipliers(105, 8), 10)).toContain('few_candidate_blocks'); // S = 96
  });
});

describe('moving-block analysis: validation before any sampling', () => {
  const sample = pseudoMultipliers(100, 2);
  const s = settings();
  const observed = observedOf(sample, STRATEGY, s, null);

  /** A sample that records every element read, to prove nothing was sampled. */
  function watched(values: number[]) {
    const reads = { count: 0 };
    const proxy = new Proxy(values, {
      get(target, key, receiver) {
        if (typeof key === 'string' && /^\d+$/.test(key)) reads.count += 1;
        return Reflect.get(target, key, receiver) as unknown;
      },
    });
    return { proxy, reads };
  }

  it('rejects invalid samples and block lengths with BlockBootstrapError, reading nothing', () => {
    const cases: [number[], number][] = [
      [sample.slice(0, 19), 2], // fewer than 20 rounds
      [sample, 1], // b = 1 is the IID bootstrap
      [sample, 11], // > ⌊100 / 10⌋
      [[], 2],
    ];
    for (const [values, blockLength] of cases) {
      const { proxy, reads } = watched(values);
      expect(() =>
        runBlockBootstrap(proxy, STRATEGY, s, { paths: 10, seed: 1, blockLength }, observed),
      ).toThrow(BlockBootstrapError);
      expect(reads.count).toBe(0);
    }
  });

  it('rejects invalid settings like the IID bootstrap (ZodError), reading nothing', () => {
    for (const options of [
      { paths: 0, seed: 1, blockLength: 5 },
      { paths: 2_001, seed: 1, blockLength: 5 },
      { paths: 10, seed: -1, blockLength: 5 },
      { paths: 10, seed: 1.5, blockLength: 5 },
      { paths: 10, seed: 1, blockLength: 2.5 },
      { paths: 10, seed: 1, blockLength: 5, extra: true },
    ]) {
      const { proxy, reads } = watched(sample);
      expect(() => runBlockBootstrap(proxy, STRATEGY, s, options as never, observed)).toThrow(
        ZodError,
      );
      expect(reads.count).toBe(0);
    }
  });

  it('refuses work over the limit before drawing anything (AnalysisLimitError)', () => {
    const large = pseudoMultipliers(1_000, 3);
    const { proxy, reads } = watched(large);
    expect(() =>
      runBlockBootstrap(proxy, STRATEGY, s, { paths: 1_001, seed: 1, blockLength: 10 }, observed),
    ).toThrow(AnalysisLimitError);
    expect(reads.count).toBe(0);
    // At the limit exactly, the analysis runs.
    expect(
      runBlockBootstrap(large, STRATEGY, s, { paths: 1_000, seed: 1, blockLength: 10 }, observed)
        .paths,
    ).toBe(1_000);
  });

  it('rejects invalid multipliers and staking plans that do not fit the strategy', () => {
    expect(() =>
      runBlockBootstrap(
        [...sample.slice(1), 99],
        STRATEGY,
        s,
        { paths: 5, seed: 1, blockLength: 5 },
        observed,
      ),
    ).toThrow(ZodError);
    const wrongBase = plan(parseProgressionConfig({ ...martingale(), baseStakeMinor: 2_000 }));
    expect(() =>
      runBlockBootstrap(
        sample,
        STRATEGY,
        s,
        { paths: 5, seed: 1, blockLength: 5 },
        observed,
        wrongBase,
      ),
    ).toThrow(/leg's stake/);
  });

  it('accepts the boundary values: n = 20 with b = 2, and b = ⌊n / 10⌋', () => {
    const twenty = sample.slice(0, 20);
    const r = runBlockBootstrap(
      twenty,
      STRATEGY,
      s,
      { paths: 3, seed: 1, blockLength: 2 },
      observedOf(twenty, STRATEGY, s, null),
    );
    expect(r.resampling).toMatchObject({
      blocksPerPath: 10,
      lastBlockLength: 2,
      candidateStarts: 19,
    });
    expect(
      runBlockBootstrap(sample, STRATEGY, s, { paths: 3, seed: 1, blockLength: 10 }, observed)
        .resampling.blocksPerPath,
    ).toBe(10);
  });
});
