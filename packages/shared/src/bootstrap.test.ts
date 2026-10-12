import { describe, expect, it } from 'vitest';
import {
  BacktestLimitError,
  createSummaryReplayer,
  runBacktest,
  STOP_REASONS,
  type BacktestSummary,
} from './backtest.js';
import {
  AnalysisLimitError,
  analysisSettingsSchema,
  BOOTSTRAP_ALGORITHM_VERSION,
  fmix32,
  MAX_ANALYSIS_PATHS,
  MAX_ANALYSIS_ROUND_STEPS,
  maxPathsForSample,
  nearestRankSorted,
  pathGenerator,
  runBootstrap,
  Xoshiro128StarStar,
} from './bootstrap.js';
import type { TwoLegStrategyConfig } from './legs.js';
import type { SimulationSettings } from './simulation.js';

// SYNTHETIC TEST FIXTURES: invented multipliers used only to exercise the bootstrap.

const STRATEGY: TwoLegStrategyConfig = {
  schemaVersion: 1,
  currency: 'NGN',
  legs: {
    A: { label: 'A', enabled: true, stakeMinor: 100, cashoutTargetX100: 200 },
    B: { label: 'B', enabled: true, stakeMinor: 100, cashoutTargetX100: 600 },
  },
};

function settings(
  overrides: Partial<Omit<SimulationSettings, 'risk'>> = {},
  risk: Partial<SimulationSettings['risk']> = {},
): SimulationSettings {
  return {
    schemaVersion: 1,
    currency: 'NGN',
    startingBankrollMinor: 1_000,
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

type Observed = Parameters<typeof runBootstrap>[4];
const OBSERVED: Observed = {
  endingBankrollMinor: 1_000,
  netProfitMinor: 0,
  maxDrawdownFraction: 0,
  maxDrawdownMinor: 0,
  roundsReplayed: 0,
  stopReason: 'completed_all_rounds',
};

const SAMPLE = [150, 200, 700, 100, 990, 205, 120, 340, 600, 110, 101, 2_500];

/** Independent reference implementation of xoshiro128** using BigInt and explicit masks. */
function referenceXoshiro(state: [number, number, number, number], count: number): number[] {
  const M = 0xffffffffn;
  let [s0, s1, s2, s3] = state.map(BigInt) as [bigint, bigint, bigint, bigint];
  const rotl = (x: bigint, k: bigint) => ((x << k) | (x >> (32n - k))) & M;
  const out: number[] = [];
  for (let i = 0; i < count; i++) {
    out.push(Number((rotl((s1 * 5n) & M, 7n) * 9n) & M));
    const t = (s1 << 9n) & M;
    s2 ^= s0;
    s3 ^= s1;
    s1 ^= s2;
    s0 ^= s3;
    s2 ^= t;
    s3 = rotl(s3, 11n);
  }
  return out;
}

/** The ending bankroll of one path, recomputed from its draws through runBacktest itself. */
function pathEndingViaRunBacktest(
  sample: number[],
  seed: number,
  path: number,
  s: SimulationSettings,
): BacktestSummary {
  const rng = pathGenerator(seed, path);
  const draws = sample.map(() => sample[rng.nextIndex(sample.length)]!);
  return runBacktest(
    draws.map((m, i) => ({
      roundId: i + 1,
      multiplierX100: m,
      eventAt: new Date(Date.UTC(2026, 0, 1) + i * 1000).toISOString(),
    })),
    STRATEGY,
    s,
  ).summary;
}

describe('pseudo-random generator', () => {
  it('matches the xoshiro128** reference sequence', () => {
    const rng = new Xoshiro128StarStar([1, 2, 3, 4]);
    const got = Array.from({ length: 5 }, () => rng.next());
    expect(got).toEqual([11520, 0, 5927040, 70819200, 2031721883]);
    expect(got).toEqual(referenceXoshiro([1, 2, 3, 4], 5));
    for (const state of [
      [0x9e3779b9, 0x243f6a88, 0xb7e15162, 0x6a09e667],
      [0xffffffff, 1, 0, 0x80000000],
    ] as [number, number, number, number][]) {
      const r = new Xoshiro128StarStar(state);
      expect(Array.from({ length: 1_000 }, () => r.next())).toEqual(referenceXoshiro(state, 1_000));
    }
    expect(() => new Xoshiro128StarStar([0, 0, 0, 0])).toThrow(/all zero/);
  });

  it('fmix32 is the MurmurHash3 finaliser', () => {
    expect(fmix32(0)).toBe(0);
    expect(fmix32(1)).toBe(0x514e28b7);
    const seen = new Set(Array.from({ length: 10_000 }, (_, i) => fmix32(i)));
    expect(seen.size).toBe(10_000);
  });

  it('pins version-1 path streams (changing them requires a new algorithm version)', () => {
    expect(BOOTSTRAP_ALGORITHM_VERSION).toBe('iid-bootstrap/xoshiro128ss-fmix32/v1');
    const g = pathGenerator(42, 0);
    expect([g.next(), g.next(), g.next()]).toEqual([2596443952, 919555074, 3956504605]);
    const h = pathGenerator(Number.MAX_SAFE_INTEGER, 7);
    expect([h.next(), h.next(), h.next()]).toEqual([2125514126, 2100708499, 1459754938]);
    const k = pathGenerator(42, 0);
    expect(Array.from({ length: 10 }, () => k.nextIndex(10))).toEqual([
      2, 4, 5, 0, 9, 1, 9, 8, 9, 3,
    ]);
  });

  it('gives distinct, reproducible streams per (seed, path)', () => {
    const first = (seed: number, path: number) => pathGenerator(seed, path).next();
    expect(first(1, 0)).toBe(first(1, 0));
    const values = new Set<number>();
    for (const seed of [0, 1, 2, 2 ** 32, 2 ** 32 + 1]) {
      for (const path of [0, 1, 2]) values.add(first(seed, path));
    }
    expect(values.size).toBe(15);
  });

  it('draws unbiased indices in range', () => {
    const rng = pathGenerator(7, 0);
    const counts = [0, 0, 0];
    for (let i = 0; i < 30_000; i++) counts[rng.nextIndex(3)]! += 1;
    for (const c of counts) expect(Math.abs(c - 10_000)).toBeLessThan(400);
    expect(rng.nextIndex(1)).toBe(0);
    expect(() => rng.nextIndex(0)).toThrow(RangeError);
  });

  it('rejects invalid seeds and path indices', () => {
    for (const bad of [-1, 1.5, Number.MAX_SAFE_INTEGER + 1, Number.NaN]) {
      expect(() => pathGenerator(bad, 0)).toThrow(RangeError);
    }
    expect(() => pathGenerator(1, -1)).toThrow(RangeError);
  });
});

describe('nearestRankSorted', () => {
  it('returns observed values with ties and single values', () => {
    const v = [1, 2, 2, 2, 9];
    expect(nearestRankSorted(v, 0)).toBe(1);
    expect(nearestRankSorted(v, 2000)).toBe(1); // ceil(0.2*5)=1
    expect(nearestRankSorted(v, 2001)).toBe(2);
    expect(nearestRankSorted(v, 5000)).toBe(2);
    expect(nearestRankSorted(v, 8000)).toBe(2); // rank 4
    expect(nearestRankSorted(v, 8001)).toBe(9);
    expect(nearestRankSorted(v, 10_000)).toBe(9);
    expect(nearestRankSorted([5], 500)).toBe(5);
    expect(() => nearestRankSorted([], 5000)).toThrow(RangeError);
    expect(() => nearestRankSorted(v, 10_001)).toThrow(RangeError);
  });
});

describe('runBootstrap', () => {
  const run = (opts: { paths: number; seed: number }, s = settings(), sample = SAMPLE) =>
    runBootstrap(sample, STRATEGY, s, opts, OBSERVED);

  it('is reproducible for the same seed and differs for another seed', () => {
    const a = run({ paths: 300, seed: 12345 });
    expect(run({ paths: 300, seed: 12345 })).toEqual(a);
    const b = run({ paths: 300, seed: 12346 });
    expect(b.endingBankrollMinor).not.toEqual(a.endingBankrollMinor);
    expect(a).toMatchObject({
      algorithmVersion: BOOTSTRAP_ALGORITHM_VERSION,
      seed: 12345,
      paths: 300,
    });
  });

  it('settles each path through runBacktest, from the starting bankroll, independently', () => {
    const s = settings();
    const one = run({ paths: 1, seed: 99 }, s);
    const p0 = pathEndingViaRunBacktest(SAMPLE, 99, 0, s);
    expect(one.endingBankrollMinor.min).toBe(p0.endingBankrollMinor);
    expect(one.maxDrawdownMinor.max).toBe(p0.maxDrawdownMinor);
    // Two paths: each equals its own independent replay from the starting bankroll.
    const two = run({ paths: 2, seed: 99 }, s);
    const p1 = pathEndingViaRunBacktest(SAMPLE, 99, 1, s);
    const expected = [p0.endingBankrollMinor, p1.endingBankrollMinor].sort((x, y) => x - y);
    expect([two.endingBankrollMinor.min, two.endingBankrollMinor.max]).toEqual(expected);
    // Adding paths never changes earlier paths (per-path streams): path 0 is the same.
    const many = run({ paths: 50, seed: 99 }, s);
    expect(many.endingBankrollMinor.min).toBeLessThanOrEqual(p0.endingBankrollMinor);
    expect(many.endingBankrollMinor.max).toBeGreaterThanOrEqual(p0.endingBankrollMinor);
  });

  it('reports consistent denominators', () => {
    const r = run({ paths: 400, seed: 3 });
    const { positive, zero, negative, denominator } = r.netOutcome;
    expect(positive + zero + negative).toBe(400);
    expect(denominator).toBe(400);
    expect(Object.values(r.stopReasons).reduce((a, b) => a + b, 0)).toBe(400);
    const o = r.observed;
    expect(o.pathsEndingBelow + o.pathsEndingEqual + o.pathsEndingAbove).toBe(o.denominator);
    expect(r.sample).toEqual({
      size: SAMPLE.length,
      distinctMultipliers: SAMPLE.length,
      minMultiplierX100: 100,
      maxMultiplierX100: 2_500,
    });
    expect(r.pathLength).toBe(SAMPLE.length);
    for (const d of [r.endingBankrollMinor, r.maxDrawdownFraction, r.roundsReplayed]) {
      const values = d.quantiles.map((q) => q.value);
      expect(values).toEqual([...values].sort((x, y) => x - y));
      expect(d.min).toBeLessThanOrEqual(values[0]!);
      expect(d.max).toBeGreaterThanOrEqual(values[values.length - 1]!);
    }
  });

  it('counts configured boundaries only when configured, matching stop reasons', () => {
    const none = run({ paths: 200, seed: 5 });
    expect(none.configuredBoundaries).toEqual({ lowerBankrollStop: null, maxDrawdownStop: null });
    const withStops = run(
      { paths: 200, seed: 5 },
      settings({}, { stopBelowBankrollMinor: 700, maxDrawdownBps: 5_000 }),
    );
    expect(withStops.configuredBoundaries.lowerBankrollStop).toEqual({
      thresholdMinor: 700,
      count: withStops.stopReasons.stop_below,
      denominator: 200,
    });
    expect(withStops.configuredBoundaries.maxDrawdownStop).toEqual({
      thresholdBps: 5_000,
      count: withStops.stopReasons.max_drawdown,
      denominator: 200,
    });
    expect(withStops.stopReasons.stop_below).toBeGreaterThan(0);
  });

  it('respects insufficient-bankroll policies and stops on every path', () => {
    // Every draw loses both legs (no multiplier reaches 2.00x). From 350 one round loses 200,
    // leaving 150: enough for one stake but not both, so stop_run ends every path there.
    const losing = [100, 100, 100, 150];
    const stopRun = run(
      { paths: 50, seed: 1 },
      settings({ startingBankrollMinor: 350, insufficientBankrollPolicy: 'stop_run' }),
      losing,
    );
    expect(stopRun.stopReasons.insufficient_bankroll).toBe(50);
    expect(stopRun.endingBankrollMinor).toMatchObject({ min: 150, max: 150 });
    // skip_leg keeps going with one leg until the bankroll cannot cover any stake.
    const skip = run({ paths: 50, seed: 1 }, settings({ startingBankrollMinor: 350 }), losing);
    expect(skip.stopReasons.bankroll_exhausted).toBe(50);
    expect(skip.endingBankrollMinor).toMatchObject({ min: 50, max: 50 });
    expect(stopRun.endingBankrollMinor.min).toBeGreaterThanOrEqual(0);
    const maxRounds = run({ paths: 20, seed: 1 }, settings({}, { maxRounds: 3 }));
    expect(maxRounds.roundsReplayed.max).toBe(3);
    expect(maxRounds.stopReasons.max_rounds).toBe(20);
  });

  it('handles a degenerate sample without claiming certainty', () => {
    const r = run({ paths: 100, seed: 8 }, settings(), [100, 100, 100]);
    expect(r.endingBankrollMinor.min).toBe(r.endingBankrollMinor.max);
    expect(r.maxDrawdownFraction.min).toBe(r.maxDrawdownFraction.max);
    expect(r.netOutcome).toEqual({ positive: 0, zero: 0, negative: 100, denominator: 100 });
    expect(r.warnings.map((w) => w.code)).toEqual([
      'degenerate_sample',
      'small_sample',
      'few_paths',
    ]);
  });

  it('warns about small samples and few paths, and not otherwise', () => {
    const big = Array.from({ length: 150 }, (_, i) => 100 + ((i * 37) % 400));
    expect(run({ paths: 300, seed: 1 }, settings(), big).warnings).toEqual([]);
    const codes = run({ paths: 50, seed: 1 }).warnings.map((w) => w.code);
    expect(codes).toEqual(['small_sample', 'few_paths']);
  });

  it('refuses excessive work before computing, and invalid settings', () => {
    const n = 5_000;
    const sample = Array.from({ length: n }, (_, i) => 100 + (i % 500));
    expect(maxPathsForSample(n)).toBe(MAX_ANALYSIS_ROUND_STEPS / n);
    expect(() => run({ paths: maxPathsForSample(n) + 1, seed: 1 }, settings(), sample)).toThrow(
      AnalysisLimitError,
    );
    expect(() => run({ paths: 1, seed: 1 }, settings(), [])).toThrow(AnalysisLimitError);
    expect(maxPathsForSample(10)).toBe(MAX_ANALYSIS_PATHS);
    for (const bad of [
      { paths: 0, seed: 1 },
      { paths: MAX_ANALYSIS_PATHS + 1, seed: 1 },
      { paths: 1.5, seed: 1 },
      { paths: 10, seed: -1 },
      { paths: 10, seed: 2.5 },
      { paths: 10, seed: Number.MAX_SAFE_INTEGER + 1 },
    ]) {
      expect(analysisSettingsSchema.safeParse(bad).success, JSON.stringify(bad)).toBe(false);
      expect(() => run(bad)).toThrow();
    }
    expect(() => run({ paths: 1, seed: 1 }, settings(), [99])).toThrow(); // invalid multiplier
  });

  it('refuses results beyond the exact integer range instead of rounding', () => {
    expect(() =>
      runBootstrap(
        [100_000_000],
        {
          ...STRATEGY,
          legs: {
            A: { ...STRATEGY.legs.A, stakeMinor: 1e12, cashoutTargetX100: 100_000_000 },
            B: { ...STRATEGY.legs.B, enabled: false },
          },
        },
        settings({ startingBankrollMinor: 1e12 }),
        { paths: 1, seed: 1 },
        OBSERVED,
      ),
    ).toThrow(BacktestLimitError);
  });
});

describe('review regressions', () => {
  const run = (opts: { paths: number; seed: number }, s = settings(), sample = SAMPLE) =>
    runBootstrap(sample, STRATEGY, s, opts, OBSERVED);

  it('ends paths at the upper stop, counted with the paths denominator', () => {
    // Every draw is 7.00x: both legs win, +600 per round. From 1,000 the bankroll reaches
    // 1,600 after the first round, which meets the upper stop of 1,500 (>=).
    const r = run(
      { paths: 40, seed: 3 },
      settings({}, { stopAtOrAboveBankrollMinor: 1_500 }),
      [700, 700, 700],
    );
    expect(r.stopReasons.stop_at_or_above).toBe(40);
    expect(Object.values(r.stopReasons).reduce((a, b) => a + b, 0)).toBe(40);
    expect(r.endingBankrollMinor).toMatchObject({ min: 1_600, max: 1_600 });
    expect(r.roundsReplayed).toMatchObject({ min: 1, max: 1 });
    expect(r.netOutcome).toEqual({ positive: 40, zero: 0, negative: 0, denominator: 40 });
    // The upper stop is not a loss boundary, so it is not reported as one.
    expect(r.configuredBoundaries).toEqual({ lowerBankrollStop: null, maxDrawdownStop: null });
  });

  it('counts a round that breaches two stops under the first in check order only', () => {
    // Every draw loses both legs: 1,000 -> 800, which is below the lower stop (900) AND a
    // 20% drawdown (>= the 1% drawdown stop) in the same round. Lower is checked first.
    const r = run(
      { paths: 25, seed: 9 },
      settings({}, { stopBelowBankrollMinor: 900, maxDrawdownBps: 100 }),
      [100, 150],
    );
    expect(r.stopReasons.stop_below).toBe(25);
    expect(r.stopReasons.max_drawdown).toBe(0);
    expect(r.configuredBoundaries.lowerBankrollStop).toEqual({
      thresholdMinor: 900,
      count: 25,
      denominator: 25,
    });
    expect(r.configuredBoundaries.maxDrawdownStop).toEqual({
      thresholdBps: 100,
      count: 0,
      denominator: 25,
    });
    // Every path DID cross the drawdown threshold: a zero count does not mean otherwise.
    expect(r.maxDrawdownFraction.min).toBeGreaterThanOrEqual(0.01);
    // The same precedence as the historical engine for the identical sequence.
    expect(
      runBacktest(
        [{ roundId: 1, multiplierX100: 100, eventAt: '2026-01-01T00:00:00.000Z' }],
        STRATEGY,
        settings({}, { stopBelowBankrollMinor: 900, maxDrawdownBps: 100 }),
      ).summary.stopReason,
    ).toBe('stop_below');
  });

  it('rejects draws at or above the acceptance limit (forced rejection branch)', () => {
    // n = 2^31 + 1: the acceptance limit is 2^32 - (2^32 mod n) = 2^31 + 1, so any draw at
    // or above it must be rejected and redrawn. Find a state whose FIRST output is rejected.
    const n = 2 ** 31 + 1;
    const limit = 2 ** 32 - (2 ** 32 % n);
    expect(limit).toBe(2 ** 31 + 1);
    let state: [number, number, number, number] | null = null;
    for (let s1 = 1; state === null; s1++) {
      const probe = new Xoshiro128StarStar([1, s1, 3, 4]);
      if (probe.next() >= limit) state = [1, s1, 3, 4];
    }
    const reference = new Xoshiro128StarStar(state);
    const rejected = reference.next();
    expect(rejected).toBeGreaterThanOrEqual(limit);
    let accepted = reference.next();
    while (accepted >= limit) accepted = reference.next();
    expect(new Xoshiro128StarStar(state).nextIndex(n)).toBe(accepted % n);
    expect(accepted % n).toBe(accepted); // accepted < limit = n here, so no wrap
  });

  it('builds a smaller run from exactly the first paths of a larger one (prefix stability)', () => {
    const s = settings({}, { stopBelowBankrollMinor: 700 });
    const replay = createSummaryReplayer(STRATEGY, s);
    // Each path, recomputed independently from its own generator and the shared replay.
    const pathSummary = (p: number) => {
      const rng = pathGenerator(77, p);
      return replay(SAMPLE.map(() => SAMPLE[rng.nextIndex(SAMPLE.length)]!));
    };
    const independent = Array.from({ length: 200 }, (_, p) => pathSummary(p));
    const sorted = (xs: number[]) => [...xs].sort((a, b) => a - b);

    // With at most 5 paths, min, the five quantiles and max list every path value, so the
    // whole multiset of endings is visible: it must equal the first P independent paths.
    for (let paths = 1; paths <= 5; paths++) {
      const d = run({ paths, seed: 77 }, s).endingBankrollMinor;
      const shown = sorted([...new Set([d.min, ...d.quantiles.map((q) => q.value), d.max])]);
      const expected = sorted([
        ...new Set(independent.slice(0, paths).map((x) => x.endingBankrollMinor)),
      ]);
      expect(shown).toEqual(expected);
    }

    // For larger runs every reported figure must equal the aggregate of the first P
    // independent paths: counts, quantiles and comparison with the observed run.
    for (const paths of [37, 200]) {
      const r = run({ paths, seed: 77 }, s);
      const first = independent.slice(0, paths);
      const endings = sorted(first.map((x) => x.endingBankrollMinor));
      expect(r.endingBankrollMinor.quantiles.map((q) => q.value)).toEqual(
        r.endingBankrollMinor.quantiles.map((q) => nearestRankSorted(endings, q.levelBps)),
      );
      expect([r.endingBankrollMinor.min, r.endingBankrollMinor.max]).toEqual([
        endings[0],
        endings[endings.length - 1],
      ]);
      for (const reason of STOP_REASONS) {
        expect(r.stopReasons[reason]).toBe(first.filter((x) => x.stopReason === reason).length);
      }
      expect(r.netOutcome.positive).toBe(first.filter((x) => x.netProfitMinor > 0).length);
      expect(r.netOutcome.negative).toBe(first.filter((x) => x.netProfitMinor < 0).length);
      expect(r.observed.pathsEndingBelow).toBe(
        first.filter((x) => x.endingBankrollMinor < OBSERVED.endingBankrollMinor).length,
      );
    }
  });
});
