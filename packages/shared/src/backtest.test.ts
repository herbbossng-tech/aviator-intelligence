import { describe, expect, it } from 'vitest';
import {
  BacktestLimitError,
  backtestDatasetQuerySchema,
  backtestDatasetSchema,
  backtestRequestSchema,
  MAX_BACKTEST_ROUNDS,
  runBacktest,
  type BacktestRound,
} from './backtest.js';
import type { TwoLegStrategyConfig } from './legs.js';
import { parseMajorAmountToMinor } from './money.js';
import type { SimulationSettings } from './simulation.js';

// SYNTHETIC TEST FIXTURES: invented multipliers and times, used only to exercise the engine.

function rounds(multipliersX100: number[]): BacktestRound[] {
  return multipliersX100.map((m, i) => ({
    roundId: i + 1,
    multiplierX100: m,
    eventAt: new Date(Date.UTC(2026, 0, 1, 0, 0, i)).toISOString(),
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

describe('runBacktest settlement', () => {
  it('settles both legs per round: A 2.00x and B 6.00x', () => {
    // 1.50x: both lose. 2.00x: A wins exactly at target. 7.00x: both win.
    const { rounds: out, summary } = runBacktest(rounds([150, 200, 700]), strategy(), settings());
    expect(out.map((r) => r.legs.map((l) => l.result))).toEqual([
      ['loss', 'loss'],
      ['win', 'loss'],
      ['win', 'win'],
    ]);
    expect(out.map((r) => r.roundNetMinor)).toEqual([-200, 0, 600]);
    expect(out.map((r) => r.bankrollAfterMinor)).toEqual([800, 800, 1_400]);
    expect(summary.endingBankrollMinor).toBe(1_400);
    expect(summary.totalStakedMinor).toBe(600);
    // Gross returned includes the stakes: A 200 + 200, B 600.
    expect(summary.totalReturnedMinor).toBe(1_000);
    expect(summary.netProfitMinor).toBe(400);
    expect(summary.netProfitMinor).toBe(summary.totalReturnedMinor - summary.totalStakedMinor);
    expect(summary.returnOnStartingBankroll).toBeCloseTo(0.4);
    expect(summary.roundsWithProfit).toBe(1);
    expect(summary.roundsWithLoss).toBe(1);
    expect(summary.roundsBreakEven).toBe(1);
    expect(summary.profitableRoundShare).toBeCloseTo(1 / 3);
    const [a, b] = summary.legs;
    expect(a).toMatchObject({ placed: 3, wins: 2, losses: 1, netMinor: 100 });
    expect(a!.targetReachedShare).toBeCloseTo(2 / 3);
    expect(b).toMatchObject({ placed: 3, wins: 1, losses: 2, netMinor: 300 });
  });

  it('treats the target boundary as inclusive (M >= T wins, M < T loses)', () => {
    const { rounds: out } = runBacktest(
      rounds([199, 200]),
      strategy({}, { enabled: false }),
      settings(),
    );
    expect(out.map((r) => r.legs[0]!.result)).toEqual(['loss', 'win']);
  });

  it('rounds gross returns down to whole minor units', () => {
    const { rounds: out } = runBacktest(
      rounds([300]),
      strategy({ stakeMinor: 33, cashoutTargetX100: 155 }, { enabled: false }),
      settings(),
    );
    // 33 * 1.55 = 51.15 -> 51.
    expect(out[0]!.legs[0]).toMatchObject({ grossReturnMinor: 51, netMinor: 18 });
  });

  it('writes no entry for a disabled leg', () => {
    const { rounds: out, summary } = runBacktest(
      rounds([700]),
      strategy({ enabled: false }),
      settings(),
    );
    expect(out[0]!.legs.map((l) => l.leg)).toEqual(['B']);
    expect(summary.legs[0]).toMatchObject({ enabled: false, placed: 0, targetReachedShare: null });
  });

  it('handles repeated identical multipliers', () => {
    const { summary } = runBacktest(rounds([250, 250, 250]), strategy(), settings());
    expect(summary.legs[0]).toMatchObject({ wins: 3, losses: 0 });
    expect(summary.legs[1]).toMatchObject({ wins: 0, losses: 3 });
    expect(summary.netProfitMinor).toBe(0);
  });
});

describe('runBacktest datasets', () => {
  it('returns an empty, well-defined summary for no rounds', () => {
    const { rounds: out, summary } = runBacktest([], strategy(), settings());
    expect(out).toEqual([]);
    expect(summary).toMatchObject({
      roundsAvailable: 0,
      roundsReplayed: 0,
      stopReason: 'completed_all_rounds',
      endingBankrollMinor: 1_000,
      netProfitMinor: 0,
      profitableRoundShare: null,
      maxDrawdownMinor: 0,
      longestLosingStreak: 0,
    });
  });

  it('replays a single round', () => {
    const { summary } = runBacktest(rounds([100]), strategy(), settings());
    expect(summary).toMatchObject({ roundsReplayed: 1, endingBankrollMinor: 800 });
  });

  it('rejects unordered, duplicate or invalid input rounds', () => {
    const r = rounds([200, 300]);
    expect(() => runBacktest([r[1]!, r[0]!], strategy(), settings())).toThrow(/increasing/);
    expect(() =>
      runBacktest([r[0]!, { ...r[1]!, eventAt: r[0]!.eventAt }], strategy(), settings()),
    ).toThrow(/increasing/);
    expect(() => runBacktest([r[0]!, { ...r[1]!, roundId: 1 }], strategy(), settings())).toThrow(
      /round id/,
    );
    expect(() => runBacktest([{ ...r[0]!, multiplierX100: 99 }], strategy(), settings())).toThrow();
    expect(() => runBacktest([{ ...r[0]!, eventAt: 'yesterday' }], strategy(), settings())).toThrow(
      /event times/,
    );
  });

  it('rejects a selection larger than the maximum', () => {
    const many = Array.from({ length: MAX_BACKTEST_ROUNDS + 1 }, (_, i) => ({
      roundId: i + 1,
      multiplierX100: 100,
      eventAt: new Date(Date.UTC(2026, 0, 1) + i * 1000).toISOString(),
    }));
    expect(() => runBacktest(many, strategy(), settings())).toThrow(/at most/);
  });
});

describe('runBacktest bankroll and risk', () => {
  it('tracks drawdown, lowest bankroll and the longest losing streak', () => {
    // net per round: +600, -200, -200, 0, -200, +600
    const { summary } = runBacktest(rounds([700, 100, 100, 200, 100, 700]), strategy(), settings());
    expect(summary.peakBankrollMinor).toBe(1_600);
    expect(summary.lowestBankrollMinor).toBe(1_000);
    expect(summary.maxDrawdownMinor).toBe(600);
    expect(summary.maxDrawdownFraction).toBeCloseTo(600 / 1_600);
    // A break-even round ends a losing streak.
    expect(summary.longestLosingStreak).toBe(2);
  });

  it('skip_leg: skips a leg it cannot fund and records it with zero stake', () => {
    const { rounds: out, summary } = runBacktest(
      rounds([100, 100]),
      strategy({ stakeMinor: 100 }, { stakeMinor: 150 }),
      settings({ startingBankrollMinor: 300 }),
    );
    // Round 1: both placed (250 <= 300) and lost -> 50 left. Round 2: 50 < min stake -> stop.
    expect(out).toHaveLength(1);
    expect(summary.stopReason).toBe('bankroll_exhausted');

    const partial = runBacktest(
      rounds([100, 700]),
      strategy({ stakeMinor: 100 }, { stakeMinor: 150 }),
      settings({ startingBankrollMinor: 400 }),
    );
    // Round 1 loses 250 -> 150. Round 2: A placed (100), B needs 150 > 50 left -> skipped.
    expect(partial.rounds[1]!.legs).toEqual([
      expect.objectContaining({ leg: 'A', result: 'win', stakeMinor: 100 }),
      expect.objectContaining({ leg: 'B', result: 'skipped', stakeMinor: 0, netMinor: 0 }),
    ]);
    expect(partial.summary.legs[1]).toMatchObject({ placed: 1, skipped: 1 });
  });

  it('stop_run: stops when the bankroll cannot cover every enabled stake', () => {
    const { rounds: out, summary } = runBacktest(
      rounds([100, 700, 700]),
      strategy({ stakeMinor: 100 }, { stakeMinor: 150 }),
      settings({ startingBankrollMinor: 400, insufficientBankrollPolicy: 'stop_run' }),
    );
    expect(out).toHaveLength(1);
    expect(summary).toMatchObject({
      stopReason: 'insufficient_bankroll',
      roundsReplayed: 1,
      roundsNotReplayed: 2,
      endingBankrollMinor: 150,
    });
  });

  it('never lets the bankroll go negative', () => {
    const { rounds: out } = runBacktest(
      rounds(Array(20).fill(100)),
      strategy({ stakeMinor: 70 }, { stakeMinor: 70 }),
      settings({ startingBankrollMinor: 500 }),
    );
    expect(out.every((r) => r.bankrollAfterMinor >= 0)).toBe(true);
  });

  it('applies the lower, upper, drawdown and round-count stops', () => {
    const losing = rounds([100, 100, 100, 100]);
    expect(
      runBacktest(losing, strategy(), settings({}, { stopBelowBankrollMinor: 700 })).summary,
    ).toMatchObject({ stopReason: 'stop_below', roundsReplayed: 2, endingBankrollMinor: 600 });
    expect(
      runBacktest(
        rounds([700, 700]),
        strategy(),
        settings({}, { stopAtOrAboveBankrollMinor: 1_600 }),
      ).summary,
    ).toMatchObject({ stopReason: 'stop_at_or_above', roundsReplayed: 1 });
    // 2000 bps = 20%: 1000 -> 800 is exactly 20%.
    expect(
      runBacktest(losing, strategy(), settings({}, { maxDrawdownBps: 2_000 })).summary,
    ).toMatchObject({ stopReason: 'max_drawdown', roundsReplayed: 1 });
    expect(runBacktest(losing, strategy(), settings({}, { maxRounds: 3 })).summary).toMatchObject({
      stopReason: 'max_rounds',
      roundsReplayed: 3,
      roundsNotReplayed: 1,
    });
    expect(runBacktest(losing, strategy(), settings({}, { maxRounds: 4 })).summary.stopReason).toBe(
      'completed_all_rounds',
    );
  });

  it('is deterministic: the same input gives the same output', () => {
    const input = rounds([150, 230, 610, 100, 990, 205, 120]);
    const first = runBacktest(input, strategy(), settings());
    const second = runBacktest(structuredClone(input), strategy(), settings());
    expect(second).toEqual(first);
  });

  it('decides without looking ahead: earlier rounds do not depend on later ones', () => {
    const base = rounds([150, 230, 610, 100]);
    const extended = [
      ...base,
      ...rounds([100, 100, 100, 100, 100]).map((r, i) => ({
        ...r,
        roundId: 100 + i,
        eventAt: new Date(Date.UTC(2026, 0, 2, 0, 0, i)).toISOString(),
      })),
    ];
    const short = runBacktest(base, strategy(), settings());
    const long = runBacktest(extended, strategy(), settings());
    expect(long.rounds.slice(0, base.length)).toEqual(short.rounds);
  });
});

describe('runBacktest configuration validation', () => {
  it('rejects invalid strategies and settings', () => {
    const r = rounds([200]);
    expect(() =>
      runBacktest(r, strategy({ enabled: false }, { enabled: false }), settings()),
    ).toThrow(/At least one leg/);
    expect(() => runBacktest(r, strategy({ cashoutTargetX100: 100 }), settings())).toThrow();
    expect(() => runBacktest(r, strategy({ stakeMinor: 0 }), settings())).toThrow();
    expect(() => runBacktest(r, strategy({ stakeMinor: 1.5 }), settings())).toThrow();
    expect(() => runBacktest(r, strategy(), settings({ startingBankrollMinor: 0 }))).toThrow();
    expect(() => runBacktest(r, strategy(), settings({ currency: 'USD' }))).toThrow(/currency/);
    expect(() =>
      runBacktest(r, strategy(), settings({}, { stopAtOrAboveBankrollMinor: 1_000 })),
    ).toThrow(/Upper stop/);
  });
});

describe('backtest API schemas', () => {
  const dataset = { source: 'synthetic-src' };

  it('requires a source and normalises dataset times', () => {
    expect(backtestDatasetSchema.safeParse({}).success).toBe(false);
    expect(
      backtestDatasetSchema.parse({ ...dataset, eventFrom: '2026-01-01T01:00:00+01:00' }),
    ).toEqual({
      source: 'synthetic-src',
      importId: null,
      eventFrom: '2026-01-01T00:00:00.000Z',
      eventTo: null,
    });
    expect(
      backtestDatasetSchema.safeParse({
        ...dataset,
        eventFrom: '2026-01-02T00:00:00Z',
        eventTo: '2026-01-01T00:00:00Z',
      }).success,
    ).toBe(false);
    expect(backtestDatasetSchema.safeParse({ ...dataset, eventFrom: '2026-01-01' }).success).toBe(
      false,
    );
  });

  it('rejects multiplier filters (no selection by outcome)', () => {
    expect(backtestDatasetSchema.safeParse({ ...dataset, minMultiplier: 2 }).success).toBe(false);
    expect(backtestDatasetQuerySchema.safeParse({ ...dataset, minMultiplier: '2' }).success).toBe(
      false,
    );
  });

  it('parses query-string datasets', () => {
    expect(
      backtestDatasetQuerySchema.parse({
        source: ' s ',
        importId: '3',
        eventTo: '2026-02-01T00:00:00Z',
      }),
    ).toEqual({ source: 's', importId: 3, eventFrom: null, eventTo: '2026-02-01T00:00:00.000Z' });
    expect(backtestDatasetQuerySchema.safeParse({ source: 's', importId: 'x' }).success).toBe(
      false,
    );
  });

  it('cross-checks stakes against the starting bankroll', () => {
    const ok = backtestRequestSchema.safeParse({
      strategy: strategy(),
      settings: settings(),
      dataset,
    });
    expect(ok.success).toBe(true);
    const tooBig = backtestRequestSchema.safeParse({
      strategy: strategy({ stakeMinor: 2_000 }),
      settings: settings(),
      dataset,
    });
    expect(tooBig.success).toBe(false);
    const stopRun = backtestRequestSchema.safeParse({
      strategy: strategy({ stakeMinor: 600 }, { stakeMinor: 600 }),
      settings: settings({ insufficientBankrollPolicy: 'stop_run' }),
      dataset,
    });
    expect(stopRun.success).toBe(false);
    const mixed = backtestRequestSchema.safeParse({
      strategy: strategy(),
      settings: settings({ currency: 'USD' }),
      dataset,
    });
    expect(mixed.success).toBe(false);
  });
});

describe('parseMajorAmountToMinor', () => {
  it('converts major-unit text to integer minor units', () => {
    expect(parseMajorAmountToMinor('500', 'NGN')).toBe(50_000);
    expect(parseMajorAmountToMinor('12.5', 'NGN')).toBe(1_250);
    expect(parseMajorAmountToMinor(' 1,000.05 ', 'NGN')).toBe(100_005);
    expect(parseMajorAmountToMinor('0', 'NGN')).toBe(0);
  });

  it('rejects malformed, negative, over-precise and oversized values', () => {
    for (const bad of ['', 'abc', '-5', '1.234', '1e3', '1.', '.5', '99999999999999']) {
      expect(parseMajorAmountToMinor(bad, 'NGN')).toBeNull();
    }
  });
});

describe('runBacktest review regressions', () => {
  it('reports the largest relative drawdown, not the relative size of the largest amount', () => {
    // Leg A only (2.00x @ 100). Start 200: a loss to 100 is a 50% drawdown (100 minor).
    // Nine wins reach a 1,000 peak; two losses fall to 800: 200 minor but only 20%.
    const { summary } = runBacktest(
      rounds([100, ...Array<number>(9).fill(200), 100, 100]),
      strategy({}, { enabled: false }),
      settings({ startingBankrollMinor: 200 }),
    );
    expect(summary.maxDrawdownMinor).toBe(200);
    expect(summary.maxDrawdownFraction).toBe(0.5);
  });

  it('keeps totals exact near 2^53 and refuses totals beyond it instead of losing precision', () => {
    // Odd stake, 1.01x target, every round wins: net +9,999,999,999 per round.
    const stake = 999_999_999_999;
    const run = (n: number) =>
      runBacktest(
        Array.from({ length: n }, (_, i) => ({
          roundId: i + 1,
          multiplierX100: 101,
          eventAt: new Date(Date.UTC(2026, 0, 1) + i * 1000).toISOString(),
        })),
        strategy({ stakeMinor: stake, cashoutTargetX100: 101 }, { enabled: false }),
        settings({ startingBankrollMinor: stake }),
      );
    const { summary } = run(8_900); // total returned ~8.99e15, just inside 2^53
    expect(BigInt(summary.totalStakedMinor)).toBe(8_900n * BigInt(stake));
    expect(BigInt(summary.totalReturnedMinor)).toBe(8_900n * ((BigInt(stake) * 101n) / 100n));
    expect(summary.netProfitMinor).toBe(summary.totalReturnedMinor - summary.totalStakedMinor);
    // 10,000 rounds stake ~1e16 in total, beyond Number.MAX_SAFE_INTEGER.
    expect(() => run(10_000)).toThrow(BacktestLimitError);
  });

  it('refuses a winning leg whose return cannot be represented exactly', () => {
    expect(() =>
      runBacktest(
        rounds([100_000_000]),
        strategy({ stakeMinor: 1e12, cashoutTargetX100: 100_000_000 }, { enabled: false }),
        settings({ startingBankrollMinor: 1e12 }),
      ),
    ).toThrow(BacktestLimitError);
  });

  it('settles a split round: one leg wins and the other loses, against the start-of-round bankroll', () => {
    // 3.00x round: A (2.00x) returns 200, B (6.00x) loses 100. Both stakes are funded from 200.
    const { rounds: out } = runBacktest(
      rounds([300]),
      strategy(),
      settings({ startingBankrollMinor: 200 }),
    );
    expect(out[0]).toMatchObject({
      bankrollBeforeMinor: 200,
      bankrollAfterMinor: 200,
      roundNetMinor: 0,
    });
    expect(
      out[0]!.legs.map((l) => [l.result, l.stakeMinor, l.grossReturnMinor, l.netMinor]),
    ).toEqual([
      ['win', 100, 200, 100],
      ['loss', 100, 0, -100],
    ]);
  });

  it('never funds leg B with leg A winnings from the same round', () => {
    // Bankroll 150: A (100) is placed, 50 remains, so B (100) is skipped even though A wins.
    const { rounds: out } = runBacktest(
      rounds([700]),
      strategy(),
      settings({ startingBankrollMinor: 150 }),
    );
    expect(out[0]!.legs.map((l) => l.result)).toEqual(['win', 'skipped']);
    expect(out[0]!.bankrollAfterMinor).toBe(250);
  });

  it('stops after a round that empties the bankroll, and reconciles at every level', () => {
    const { rounds: out, summary } = runBacktest(
      rounds([100, 700]),
      strategy(),
      settings({ startingBankrollMinor: 200 }),
    );
    expect(out).toHaveLength(1);
    expect(summary).toMatchObject({
      endingBankrollMinor: 0,
      lowestBankrollMinor: 0,
      stopReason: 'bankroll_exhausted',
      roundsNotReplayed: 1,
      maxDrawdownFraction: 1,
    });
    for (const r of out) {
      expect(r.bankrollAfterMinor - r.bankrollBeforeMinor).toBe(r.roundNetMinor);
      expect(r.legs.reduce((s, l) => s + l.netMinor, 0)).toBe(r.roundNetMinor);
      for (const l of r.legs) expect(l.netMinor).toBe(l.grossReturnMinor - l.stakeMinor);
    }
    for (const l of summary.legs) {
      expect(l.netMinor).toBe(l.grossReturnMinor - l.stakedMinor);
      expect(l.wins + l.losses).toBe(l.placed);
    }
  });

  it('applies stops exactly at their boundaries', () => {
    // Lower stop is strict (<): ending exactly on it does not stop.
    expect(
      runBacktest(rounds([100, 100]), strategy(), settings({}, { stopBelowBankrollMinor: 800 }))
        .summary,
    ).toMatchObject({ stopReason: 'stop_below', roundsReplayed: 2, endingBankrollMinor: 600 });
    // Upper stop is inclusive (>=).
    expect(
      runBacktest(
        rounds([700, 700]),
        strategy(),
        settings({}, { stopAtOrAboveBankrollMinor: 1_600 }),
      ).summary,
    ).toMatchObject({
      stopReason: 'stop_at_or_above',
      roundsReplayed: 1,
      endingBankrollMinor: 1_600,
    });
    // Drawdown 1999 bps is not reached by a 20% fall; 2000 bps is (exact comparison).
    const losing = rounds([100, 100]);
    expect(
      runBacktest(losing, strategy(), settings({}, { maxDrawdownBps: 2_001 })).summary
        .roundsReplayed,
    ).toBe(2);
    expect(
      runBacktest(losing, strategy(), settings({}, { maxDrawdownBps: 2_000 })).summary
        .roundsReplayed,
    ).toBe(1);
  });
});
