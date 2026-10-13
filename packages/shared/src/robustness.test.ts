import { beforeEach, describe, expect, it, vi } from 'vitest';
import { ZodError } from 'zod';
import { MAX_BACKTEST_ROUNDS, runBacktest, type BacktestRound } from './backtest.js';
import type { TwoLegStrategyConfig } from './legs.js';
import {
  assertRobustnessWorkload,
  blockRobustnessResultSchema,
  MAX_ROBUSTNESS_ROUND_STEPS,
  maxWindowsForSample,
  MIN_ROUNDS_PER_WINDOW,
  partitionChronological,
  ROBUSTNESS_ALGORITHM_VERSION,
  RobustnessLimitError,
  runBlockRobustness,
} from './robustness.js';
import type { SimulationSettings } from './simulation.js';

// Counts every replay the engine performs, through the real replay loop.
const replays = vi.hoisted(() => ({ count: 0 }));
vi.mock('./backtest.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('./backtest.js')>();
  return {
    ...actual,
    createSummaryReplayer: (...args: Parameters<typeof actual.createSummaryReplayer>) => {
      const replay = actual.createSummaryReplayer(...args);
      return (multipliers: ArrayLike<number>) => {
        replays.count += 1;
        return replay(multipliers);
      };
    },
  };
});

beforeEach(() => {
  replays.count = 0;
});

// SYNTHETIC TEST FIXTURES: invented multipliers and times, used only to exercise the engine.

function rounds(multipliersX100: readonly number[]): BacktestRound[] {
  return multipliersX100.map((m, i) => ({
    roundId: i + 1,
    multiplierX100: m,
    eventAt: new Date(Date.UTC(2026, 0, 1, 0, 0, 0, 0) + i * 1_000).toISOString(),
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

function strategy(
  a: Partial<TwoLegStrategyConfig['legs']['A']> = {},
  b: Partial<TwoLegStrategyConfig['legs']['B']> = {},
): TwoLegStrategyConfig {
  return {
    schemaVersion: 1,
    currency: 'NGN',
    legs: {
      A: { label: 'A', enabled: true, stakeMinor: 100, cashoutTargetX100: 200, ...a },
      B: { label: 'B', enabled: true, stakeMinor: 100, cashoutTargetX100: 600, ...b },
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

/** Asserts the full sample and every block equal direct runBacktest calls on the same rounds. */
function expectMatchesDirectBacktests(
  sample: BacktestRound[],
  s: TwoLegStrategyConfig,
  cfg: SimulationSettings,
  windows: number,
) {
  const result = runBlockRobustness(sample, s, cfg, { windows });
  expect(result.full.summary).toEqual(runBacktest(sample, s, cfg).summary);
  expect(result.blocks).toHaveLength(windows);
  for (const block of result.blocks) {
    const slice = sample.slice(block.startIndex, block.endIndex);
    expect(block.summary).toEqual(runBacktest(slice, s, cfg).summary);
    expect(block.firstRoundId).toBe(slice[0]!.roundId);
    expect(block.lastRoundId).toBe(slice.at(-1)!.roundId);
    expect(block.firstEventAt).toBe(slice[0]!.eventAt);
    expect(block.lastEventAt).toBe(slice.at(-1)!.eventAt);
  }
  return result;
}

/** Exact reconciliation identities of one summary. */
function expectReconciles(summary: ReturnType<typeof runBacktest>['summary']) {
  expect(summary.endingBankrollMinor).toBe(summary.startingBankrollMinor + summary.netProfitMinor);
  expect(summary.netProfitMinor).toBe(summary.totalReturnedMinor - summary.totalStakedMinor);
  expect(summary.roundsReplayed + summary.roundsNotReplayed).toBe(summary.roundsAvailable);
  expect(summary.legs.reduce((t, l) => t + l.stakedMinor, 0)).toBe(summary.totalStakedMinor);
  expect(summary.legs.reduce((t, l) => t + l.netMinor, 0)).toBe(summary.netProfitMinor);
  expect(summary.peakBankrollMinor - summary.lowestBankrollMinor).toBeGreaterThanOrEqual(
    summary.maxDrawdownMinor,
  );
}

describe('partitionChronological', () => {
  it('splits 10 rounds into 3 half-open blocks, earliest blocks taking the remainder', () => {
    expect(partitionChronological(10, 3, 1)).toEqual([
      { index: 0, startIndex: 0, endIndex: 4, roundCount: 4 },
      { index: 1, startIndex: 4, endIndex: 7, roundCount: 3 },
      { index: 2, startIndex: 7, endIndex: 10, roundCount: 3 },
    ]);
  });

  it('rejects 10 rounds in 3 blocks under the default 30-round minimum', () => {
    expect(() => partitionChronological(10, 3)).toThrow(RobustnessLimitError);
  });

  it('divides evenly when it can', () => {
    expect(partitionChronological(90, 3).map((b) => [b.startIndex, b.endIndex])).toEqual([
      [0, 30],
      [30, 60],
      [60, 90],
    ]);
  });

  it('gives the remainder to the earliest blocks', () => {
    expect(partitionChronological(100, 3).map((b) => b.roundCount)).toEqual([34, 33, 33]);
    expect(partitionChronological(307, 10).map((b) => b.roundCount)).toEqual([
      31, 31, 31, 31, 31, 31, 31, 30, 30, 30,
    ]);
  });

  it('covers every index exactly once with contiguous blocks differing in size by at most one', () => {
    for (let windows = 2; windows <= 10; windows++) {
      for (let n = windows * MIN_ROUNDS_PER_WINDOW; n <= 400; n += 7) {
        const blocks = partitionChronological(n, windows);
        expect(blocks).toHaveLength(windows);
        const seen = new Array<number>(n).fill(0);
        let expectedStart = 0;
        for (const [i, b] of blocks.entries()) {
          expect(b.index).toBe(i);
          expect(b.startIndex).toBe(expectedStart);
          expect(b.endIndex - b.startIndex).toBe(b.roundCount);
          expect(b.roundCount).toBeGreaterThanOrEqual(MIN_ROUNDS_PER_WINDOW);
          for (let k = b.startIndex; k < b.endIndex; k++) seen[k]! += 1;
          expectedStart = b.endIndex;
        }
        expect(expectedStart).toBe(n);
        expect(seen.every((c) => c === 1)).toBe(true);
        const sizes = blocks.map((b) => b.roundCount);
        expect(Math.max(...sizes) - Math.min(...sizes)).toBeLessThanOrEqual(1);
        // Larger blocks come first.
        expect([...sizes].sort((x, y) => y - x)).toEqual(sizes);
        expect(sizes.reduce((t, s) => t + s, 0)).toBe(n);
      }
    }
  });

  it('accepts exactly 30 rounds per block and rejects one round fewer (no truncation)', () => {
    expect(partitionChronological(60, 2).map((b) => b.roundCount)).toEqual([30, 30]);
    expect(() => partitionChronological(59, 2)).toThrow(/at least 60 are needed/);
    expect(() => partitionChronological(299, 10)).toThrow(RobustnessLimitError);
    expect(partitionChronological(300, 10)).toHaveLength(10);
  });

  it('rejects invalid block counts', () => {
    for (const w of [1, 0, -2, 11, 2.5, Number.NaN, Infinity]) {
      expect(() => partitionChronological(600, w), String(w)).toThrow(RobustnessLimitError);
    }
  });

  it('rejects negative, fractional, non-numeric and unsafe round counts', () => {
    for (const n of [-1, 60.5, Number.NaN, Infinity, Number.MAX_SAFE_INTEGER + 1, '60']) {
      expect(() => partitionChronological(n as number, 2), String(n)).toThrow(RobustnessLimitError);
    }
    expect(() => partitionChronological(0, 2)).toThrow(RobustnessLimitError);
    expect(() => partitionChronological(60, 2, 0)).toThrow(RobustnessLimitError);
  });

  it('reports the largest usable block count for a sample size', () => {
    expect(maxWindowsForSample(59)).toBe(0);
    expect(maxWindowsForSample(60)).toBe(2);
    expect(maxWindowsForSample(95)).toBe(3);
    expect(maxWindowsForSample(300)).toBe(10);
    expect(maxWindowsForSample(100_000)).toBe(10);
  });
});

describe('runBlockRobustness: replay correctness', () => {
  it('matches direct backtests of the full sample and of every block exactly', () => {
    const sample = rounds(pseudoMultipliers(317, 7));
    for (let windows = 2; windows <= 10; windows++) {
      const result = expectMatchesDirectBacktests(sample, strategy(), settings(), windows);
      for (const summary of [result.full.summary, ...result.blocks.map((b) => b.summary)]) {
        expectReconciles(summary);
      }
    }
  });

  it('matches direct backtests under every stop and policy setting', () => {
    const sample = rounds(pseudoMultipliers(240, 99));
    const cases: SimulationSettings[] = [
      settings({}, { stopBelowBankrollMinor: 700 }),
      settings({}, { stopAtOrAboveBankrollMinor: 1_600 }),
      settings({}, { maxDrawdownBps: 2_500 }),
      settings({}, { maxRounds: 17 }),
      settings({ startingBankrollMinor: 450, insufficientBankrollPolicy: 'stop_run' }),
      settings({ startingBankrollMinor: 450, insufficientBankrollPolicy: 'skip_leg' }),
      settings(
        { startingBankrollMinor: 5_000 },
        { stopBelowBankrollMinor: 3_000, stopAtOrAboveBankrollMinor: 8_000, maxDrawdownBps: 4_000 },
      ),
    ];
    for (const cfg of cases) {
      for (const windows of [2, 3, 8]) {
        const result = expectMatchesDirectBacktests(sample, strategy(), cfg, windows);
        for (const b of result.blocks) expectReconciles(b.summary);
      }
    }
  });

  it('starts every block from the configured bankroll, so a stop in one block does not stop another', () => {
    // Block 0 loses every round (both legs miss at 1.00x); block 1 wins both legs every round.
    const sample = rounds([...new Array<number>(30).fill(100), ...new Array<number>(30).fill(700)]);
    const cfg = settings({}, { stopBelowBankrollMinor: 500 });
    const result = expectMatchesDirectBacktests(sample, strategy(), cfg, 2);

    // Full sample: 1,000 -> 800 -> 600 -> 400 (< 500), stop after round 3; it never reaches block 1.
    expect(result.full.summary.stopReason).toBe('stop_below');
    expect(result.full.summary.roundsReplayed).toBe(3);
    expect(result.full.summary.roundsNotReplayed).toBe(57);

    const [first, second] = result.blocks;
    expect(first!.summary).toMatchObject({
      stopReason: 'stop_below',
      startingBankrollMinor: 1_000,
      endingBankrollMinor: 400,
      roundsReplayed: 3,
      roundsNotReplayed: 27,
    });
    // Block 1 is unaffected by block 0's stop: fresh bankroll, fresh peak, all 30 rounds.
    expect(second!.summary).toMatchObject({
      stopReason: 'completed_all_rounds',
      startingBankrollMinor: 1_000,
      endingBankrollMinor: 1_000 + 30 * 600,
      roundsReplayed: 30,
      roundsNotReplayed: 0,
      maxDrawdownMinor: 0,
      peakBankrollMinor: 1_000 + 30 * 600,
      lowestBankrollMinor: 1_000,
      longestLosingStreak: 0,
    });
  });

  it('resets peak and drawdown per block (upper stop and drawdown stop)', () => {
    // Block 0 rises then falls; block 1 falls from the start.
    const block0 = [700, 700, 700, ...new Array<number>(27).fill(100)];
    const block1 = new Array<number>(30).fill(100);
    const sample = rounds([...block0, ...block1]);

    const upper = expectMatchesDirectBacktests(
      sample,
      strategy(),
      settings({}, { stopAtOrAboveBankrollMinor: 2_000 }),
      2,
    );
    // 1,000 -> 1,600 -> 2,200: upper stop after round 2 of block 0.
    expect(upper.blocks[0]!.summary).toMatchObject({
      stopReason: 'stop_at_or_above',
      roundsReplayed: 2,
    });
    expect(upper.blocks[1]!.summary.stopReason).toBe('bankroll_exhausted');

    const drawdown = expectMatchesDirectBacktests(
      sample,
      strategy(),
      settings({}, { maxDrawdownBps: 3_000 }),
      2,
    );
    // Block 0 peaks at 2,800 after 3 rounds; 2,800 -> 2,600 -> 2,400 -> 2,200 -> 2,000 (28.6%) -> 1,800 (35.7%).
    expect(drawdown.blocks[0]!.summary).toMatchObject({
      stopReason: 'max_drawdown',
      peakBankrollMinor: 2_800,
      roundsReplayed: 8,
    });
    // Block 1's peak is its own starting bankroll, not block 0's 2,800: 1,000 -> 800 -> 600 (40%).
    expect(drawdown.blocks[1]!.summary).toMatchObject({
      stopReason: 'max_drawdown',
      peakBankrollMinor: 1_000,
      endingBankrollMinor: 600,
      roundsReplayed: 2,
    });
  });

  it('applies maxRounds to each block separately', () => {
    const sample = rounds(pseudoMultipliers(90, 3));
    const result = expectMatchesDirectBacktests(
      sample,
      strategy(),
      settings({}, { maxRounds: 10 }),
      3,
    );
    expect(result.full.summary).toMatchObject({ roundsReplayed: 10, roundsNotReplayed: 80 });
    for (const b of result.blocks) {
      expect(b.summary).toMatchObject({
        stopReason: 'max_rounds',
        roundsAvailable: 30,
        roundsReplayed: 10,
        roundsNotReplayed: 20,
      });
    }
  });

  it('keeps the insufficient-bankroll policies: stop_run stops, skip_leg skips', () => {
    // 300 -> 100 after one losing round: covers leg A (100) but not A + B (200).
    const sample = rounds([
      100,
      ...new Array<number>(29).fill(150),
      ...new Array<number>(30).fill(150),
    ]);
    const stopRun = expectMatchesDirectBacktests(
      sample,
      strategy(),
      settings({ startingBankrollMinor: 300, insufficientBankrollPolicy: 'stop_run' }),
      2,
    );
    expect(stopRun.blocks[0]!.summary).toMatchObject({
      stopReason: 'insufficient_bankroll',
      roundsReplayed: 1,
    });
    const skipLeg = expectMatchesDirectBacktests(
      sample,
      strategy(),
      settings({ startingBankrollMinor: 300, insufficientBankrollPolicy: 'skip_leg' }),
      2,
    );
    expect(skipLeg.blocks[0]!.summary.legs[1]!.skipped).toBeGreaterThan(0);
    // Block 1 starts again from 300, so both legs are funded in its first round.
    expect(skipLeg.blocks[1]!.summary.legs.map((l) => l.placed)[1]).toBeGreaterThan(0);
  });

  it('reports the sample, the blocks and the actual stored event times', () => {
    const sample = rounds(pseudoMultipliers(95, 11));
    const result = runBlockRobustness(sample, strategy(), settings(), { windows: 3 });
    expect(result).toMatchObject({
      algorithmVersion: ROBUSTNESS_ALGORITHM_VERSION,
      windows: 3,
      sampleSize: 95,
      roundStepsBudgeted: 190,
      full: { firstEventAt: sample[0]!.eventAt, lastEventAt: sample[94]!.eventAt },
    });
    expect(result.blocks.map((b) => [b.startIndex, b.endIndex, b.firstEventAt])).toEqual([
      [0, 32, sample[0]!.eventAt],
      [32, 64, sample[32]!.eventAt],
      [64, 95, sample[64]!.eventAt],
    ]);
    // One full replay plus one per block.
    expect(replays.count).toBe(4);
  });

  it('produces JSON that round-trips through its schema unchanged', () => {
    const result = runBlockRobustness(rounds(pseudoMultipliers(200, 5)), strategy(), settings(), {
      windows: 4,
    });
    const json = JSON.parse(JSON.stringify(result)) as unknown;
    expect(blockRobustnessResultSchema.parse(json)).toEqual(result);
  });
});

describe('runBlockRobustness: determinism and independence', () => {
  it('returns identical results for identical inputs and does not mutate them', () => {
    const sample = rounds(pseudoMultipliers(150, 21)).map((r) => Object.freeze(r));
    Object.freeze(sample);
    const s = Object.freeze(strategy());
    const cfg = Object.freeze(settings({}, { maxDrawdownBps: 5_000 }));
    const before = JSON.stringify([sample, s, cfg]);
    const a = runBlockRobustness(sample, s, cfg, { windows: 5 });
    const b = runBlockRobustness(sample, s, cfg, { windows: 5 });
    expect(b).toEqual(a);
    expect(JSON.stringify([sample, s, cfg])).toBe(before);
  });

  it('a changed multiplier affects only its own block and the full sample', () => {
    const multipliers = pseudoMultipliers(90, 4).map((m) => (m >= 600 ? 150 : m));
    // A bankroll large enough that no block can stop before round 45.
    const cfg = settings({ startingBankrollMinor: 100_000 });
    const original = runBlockRobustness(rounds(multipliers), strategy(), cfg, { windows: 3 });
    const changed = [...multipliers];
    changed[45] = 700; // inside block 1 [30, 60): both legs now win this round
    const after = runBlockRobustness(rounds(changed), strategy(), cfg, { windows: 3 });

    expect(after.blocks[0]).toEqual(original.blocks[0]);
    expect(after.blocks[2]).toEqual(original.blocks[2]);
    expect(after.blocks[1]!.summary).not.toEqual(original.blocks[1]!.summary);
    expect(after.full.summary).not.toEqual(original.full.summary);
  });

  it('later rounds never influence an earlier block (no look-ahead)', () => {
    const multipliers = pseudoMultipliers(120, 8);
    const base = runBlockRobustness(rounds(multipliers), strategy(), settings(), { windows: 4 });
    const reversedTail = [...multipliers.slice(0, 60), ...multipliers.slice(60).reverse()];
    const other = runBlockRobustness(rounds(reversedTail), strategy(), settings(), {
      windows: 4,
    });
    expect(other.blocks.slice(0, 2)).toEqual(base.blocks.slice(0, 2));
  });
});

describe('runBlockRobustness: limits and validation before any replay', () => {
  it('refuses a sample above the backtest limit without replaying anything', () => {
    const big = rounds(new Array<number>(MAX_BACKTEST_ROUNDS + 1).fill(150));
    expect(() => runBlockRobustness(big, strategy(), settings(), { windows: 2 })).toThrow(
      RobustnessLimitError,
    );
    expect(replays.count).toBe(0);
  });

  it('refuses too few rounds per block and invalid block counts without replaying', () => {
    const sample = rounds(pseudoMultipliers(89, 2));
    expect(() => runBlockRobustness(sample, strategy(), settings(), { windows: 3 })).toThrow(
      RobustnessLimitError,
    );
    expect(() => runBlockRobustness([], strategy(), settings(), { windows: 2 })).toThrow(
      RobustnessLimitError,
    );
    for (const options of [{ windows: 1 }, { windows: 11 }, { windows: 2.5 }, {}]) {
      expect(() =>
        runBlockRobustness(sample, strategy(), settings(), options as { windows: number }),
      ).toThrow(ZodError);
    }
    expect(() =>
      runBlockRobustness(sample, strategy(), settings(), { windows: 2, extra: 1 } as never),
    ).toThrow(ZodError);
    expect(replays.count).toBe(0);
  });

  it('refuses unordered, duplicate or invalid rounds without replaying', () => {
    const sample = rounds(pseudoMultipliers(60, 6));
    const swapped = [...sample];
    [swapped[40], swapped[41]] = [swapped[41]!, swapped[40]!];
    expect(() => runBlockRobustness(swapped, strategy(), settings(), { windows: 2 })).toThrow(
      /strictly increasing/,
    );
    const duplicateId = sample.map((r, i) => (i === 59 ? { ...r, roundId: 1 } : r));
    expect(() => runBlockRobustness(duplicateId, strategy(), settings(), { windows: 2 })).toThrow(
      /round id/,
    );
    const badMultiplier = sample.map((r, i) => (i === 59 ? { ...r, multiplierX100: 99 } : r));
    expect(() => runBlockRobustness(badMultiplier, strategy(), settings(), { windows: 2 })).toThrow(
      ZodError,
    );
    expect(replays.count).toBe(0);
  });

  it('refuses event times whose text order is not chronological order (self-review regression)', () => {
    const sample = rounds(pseudoMultipliers(60, 6));
    // As text, '2026-01-01T00:00:30+01:00' sorts between rounds 30 and 32
    // ('...00:00:29.000Z' < it < '...00:00:31.000Z'), but the instant is 2025-12-31T23:00:30Z,
    // earlier than every other round, so the blocks would not be chronological. runBacktest
    // accepts this input (canonical form is left to its caller); this engine enforces it.
    const offset = sample.map((r, i) =>
      i === 30 ? { ...r, eventAt: '2026-01-01T00:00:30+01:00' } : r,
    );
    expect(() => runBacktest(offset, strategy(), settings())).not.toThrow();
    expect(() => runBlockRobustness(offset, strategy(), settings(), { windows: 2 })).toThrow(
      /canonical UTC form/,
    );
    // Each of these keeps the text order increasing, so only the canonical-form check rejects it.
    for (const eventAt of ['2026-01-01T00:00:59Z', '2026-01-01T00:00:59.000+00:00']) {
      const variant = sample.map((r, i) => (i === 59 ? { ...r, eventAt } : r));
      expect(
        () => runBlockRobustness(variant, strategy(), settings(), { windows: 2 }),
        eventAt,
      ).toThrow(/canonical UTC form/);
    }
    expect(replays.count).toBe(0);
  });

  it('refuses invalid strategies and settings without replaying', () => {
    const sample = rounds(pseudoMultipliers(60, 6));
    expect(() =>
      runBlockRobustness(sample, strategy({ enabled: false }, { enabled: false }), settings(), {
        windows: 2,
      }),
    ).toThrow(ZodError);
    expect(() =>
      runBlockRobustness(sample, strategy(), settings({ currency: 'USD' }), { windows: 2 }),
    ).toThrow(/same currency/);
    expect(() =>
      runBlockRobustness(sample, strategy(), settings({}, { stopBelowBankrollMinor: 1_000 }), {
        windows: 2,
      }),
    ).toThrow(ZodError);
    expect(replays.count).toBe(0);
  });

  it('refuses results beyond the exact integer range, as the backtest does', () => {
    const sample = rounds(new Array<number>(60).fill(100_000_000));
    const huge = strategy(
      { stakeMinor: 1_000_000_000_000, cashoutTargetX100: 100_000_000 },
      { enabled: false },
    );
    expect(() =>
      runBlockRobustness(sample, huge, settings({ startingBankrollMinor: 1_000_000_000_000 }), {
        windows: 2,
      }),
    ).toThrow(/exactly representable/);
  });
});

describe('assertRobustnessWorkload', () => {
  it('allows up to the limit of replayed rounds (configurations x 2 x sample size)', () => {
    expect(MAX_ROBUSTNESS_ROUND_STEPS).toBe(1_000_000);
    expect(assertRobustnessWorkload(500_000, 1)).toBe(1_000_000);
    expect(assertRobustnessWorkload(100_000, 5)).toBe(1_000_000);
    expect(() => assertRobustnessWorkload(500_001, 1)).toThrow(RobustnessLimitError);
    expect(() => assertRobustnessWorkload(100_000, 6)).toThrow(RobustnessLimitError);
  });

  it('rejects malformed or unsafe counts without overflowing', () => {
    expect(() =>
      assertRobustnessWorkload(Number.MAX_SAFE_INTEGER, Number.MAX_SAFE_INTEGER),
    ).toThrow(RobustnessLimitError);
    for (const [n, c] of [
      [0, 1],
      [-5, 1],
      [10.5, 1],
      [10, 0],
      [10, 1.5],
      [Number.NaN, 1],
      [Number.MAX_SAFE_INTEGER + 2, 1],
    ] as const) {
      expect(() => assertRobustnessWorkload(n, c), `${n}, ${c}`).toThrow(RobustnessLimitError);
    }
  });
});
