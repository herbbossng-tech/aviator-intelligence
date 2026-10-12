import { describe, expect, it } from 'vitest';
import {
  analyticsQuerySchema,
  computeAnalytics,
  computeHistogram,
  computeSummary,
  computeThresholds,
  DEFAULT_HISTOGRAM_EDGES_X100,
  histogramBinLabel,
  MAX_ANALYTICS_ROUNDS,
  MAX_THRESHOLDS,
  nearestRankQuantileX100,
  wilsonInterval,
  type MultiplierFrequency,
} from './analytics.js';

// SYNTHETIC TEST FIXTURES: hand-built frequency tables, not real Aviator history.

/** Builds a frequency table from raw x100 values (any order, repeats allowed). */
function freq(values: number[]): MultiplierFrequency[] {
  const counts = new Map<number, number>();
  for (const v of values) counts.set(v, (counts.get(v) ?? 0) + 1);
  return [...counts.entries()]
    .sort(([a], [b]) => a - b)
    .map(([multiplierX100, count]) => ({ multiplierX100, count }));
}

describe('computeSummary', () => {
  it('returns null for an empty dataset (no NaN or Infinity)', () => {
    expect(computeSummary([])).toBeNull();
  });

  it('handles a single record', () => {
    expect(computeSummary(freq([235]))).toEqual({
      count: 1,
      minX100: 235,
      maxX100: 235,
      meanX100: 235,
      medianX100: 235,
      quantiles: [2500, 5000, 7500, 9000, 9500, 9900].map((levelBps) => ({
        levelBps,
        valueX100: 235,
      })),
    });
  });

  it('handles all-equal values', () => {
    const summary = computeSummary([{ multiplierX100: 100, count: 1000 }])!;
    expect(summary).toMatchObject({
      count: 1000,
      minX100: 100,
      maxX100: 100,
      meanX100: 100,
      medianX100: 100,
    });
  });

  it('computes min, max, mean and nearest-rank quantiles', () => {
    const summary = computeSummary(freq([100, 200, 300, 400]))!;
    expect(summary.minX100).toBe(100);
    expect(summary.maxX100).toBe(400);
    expect(summary.meanX100).toBe(250);
    // Nearest rank: for an even count the median is the LOWER middle value.
    expect(summary.medianX100).toBe(200);
    expect(summary.quantiles).toEqual([
      { levelBps: 2500, valueX100: 100 },
      { levelBps: 5000, valueX100: 200 },
      { levelBps: 7500, valueX100: 300 },
      { levelBps: 9000, valueX100: 400 },
      { levelBps: 9500, valueX100: 400 },
      { levelBps: 9900, valueX100: 400 },
    ]);
  });

  it('reports the mean to 0.01 x100 units without rounding source values', () => {
    expect(computeSummary(freq([100, 100, 101]))!.meanX100).toBe(100.33);
    expect(computeSummary(freq([150, 151]))!.meanX100).toBe(150.5);
  });

  it('stays exact with very high multipliers', () => {
    const summary = computeSummary([
      { multiplierX100: 100, count: 3 },
      { multiplierX100: 100_000_000, count: 1 },
    ])!;
    expect(summary.maxX100).toBe(100_000_000);
    expect(summary.meanX100).toBe(25_000_075);
    expect(summary.medianX100).toBe(100);
    expect(summary.quantiles.at(-1)).toEqual({ levelBps: 9900, valueX100: 100_000_000 });
  });

  it('handles a very large but supported dataset exactly', () => {
    const summary = computeSummary([
      { multiplierX100: 100, count: MAX_ANALYTICS_ROUNDS - 1 },
      { multiplierX100: 100_000_000, count: 1 },
    ])!;
    expect(summary.count).toBe(MAX_ANALYTICS_ROUNDS);
    expect(Number.isFinite(summary.meanX100)).toBe(true);
    expect(summary.quantiles.at(-1)!.valueX100).toBe(100);
  });
});

describe('nearestRankQuantileX100', () => {
  it('uses exact integer rank arithmetic (p07 of 1..100 is the 7th value, not the 8th)', () => {
    const values = Array.from({ length: 100 }, (_, i) => 101 + i);
    expect(nearestRankQuantileX100(freq(values), 700)).toBe(107);
    expect(nearestRankQuantileX100(freq(values), 0)).toBe(101);
    expect(nearestRankQuantileX100(freq(values), 10_000)).toBe(200);
  });

  it('returns null for an empty dataset and rejects invalid levels', () => {
    expect(nearestRankQuantileX100([], 5000)).toBeNull();
    expect(() => nearestRankQuantileX100(freq([100]), 10_001)).toThrow(RangeError);
    expect(() => nearestRankQuantileX100(freq([100]), 50.5)).toThrow(RangeError);
  });
});

describe('wilsonInterval', () => {
  it('matches published reference values', () => {
    const a = wilsonInterval(5, 10)!;
    expect(a.lower).toBeCloseTo(0.23659, 4);
    expect(a.upper).toBeCloseTo(0.76341, 4);
    const b = wilsonInterval(50, 100)!;
    expect(b.lower).toBeCloseTo(0.40383, 4);
    expect(b.upper).toBeCloseTo(0.59617, 4);
  });

  it('is exact at the edges and stays inside [0, 1]', () => {
    expect(wilsonInterval(0, 10)).toEqual({ lower: 0, upper: expect.closeTo(0.27753, 4) });
    expect(wilsonInterval(10, 10)).toEqual({ lower: expect.closeTo(0.72247, 4), upper: 1 });
    expect(wilsonInterval(1, 1)).toEqual({ lower: expect.closeTo(0.20654, 4), upper: 1 });
    const big = wilsonInterval(1, 5_000_000)!;
    expect(big.lower).toBeGreaterThan(0);
    expect(big.upper).toBeLessThan(1e-5);
  });

  it('returns null for an empty denominator instead of a fabricated interval', () => {
    expect(wilsonInterval(0, 0)).toBeNull();
  });

  it('rejects impossible inputs', () => {
    expect(() => wilsonInterval(11, 10)).toThrow(RangeError);
    expect(() => wilsonInterval(-1, 10)).toThrow(RangeError);
    expect(() => wilsonInterval(1.5, 10)).toThrow(RangeError);
    expect(() => wilsonInterval(1, 10, 0)).toThrow(RangeError);
  });
});

describe('computeThresholds (empirical P(M >= t))', () => {
  const data = freq([100, 150, 199, 200, 200, 350, 1000]);

  it('counts multipliers at or above each threshold, including exact equality', () => {
    const results = computeThresholds(data, [200, 150, 1000, 1001]);
    expect(results.map((r) => [r.thresholdX100, r.count, r.denominator])).toEqual([
      [150, 6, 7],
      [200, 4, 7], // the two exact 2.00x values count as "at or above"
      [1000, 1, 7],
      [1001, 0, 7],
    ]);
    expect(results[1]!.proportion).toBeCloseTo(4 / 7, 12);
    expect(results[3]!.ci95).toEqual({ lower: 0, upper: expect.any(Number) });
  });

  it('uses the default thresholds when none are given', () => {
    expect(computeThresholds(data).map((r) => r.thresholdX100)).toEqual([
      120, 150, 200, 300, 500, 1000, 2000,
    ]);
  });

  it('reports null proportions and intervals for an empty dataset', () => {
    for (const r of computeThresholds([])) {
      expect(r).toMatchObject({ count: 0, denominator: 0, proportion: null, ci95: null });
    }
  });

  it('rejects invalid thresholds', () => {
    expect(() => computeThresholds(data, [99])).toThrow(RangeError);
    expect(() => computeThresholds(data, [150.5])).toThrow(RangeError);
    expect(() => computeThresholds(data, [100_000_001])).toThrow(RangeError);
    expect(() =>
      computeThresholds(
        data,
        Array.from({ length: MAX_THRESHOLDS + 1 }, (_, i) => 101 + i),
      ),
    ).toThrow(RangeError);
  });
});

describe('computeHistogram', () => {
  it('places every round in exactly one half-open bin, with an open-ended tail', () => {
    const values = [100, 101, 119, 120, 149, 150, 199, 200, 9999, 10000, 100_000_000];
    const { denominator, bins } = computeHistogram(freq(values));
    expect(denominator).toBe(values.length);
    expect(bins.reduce((s, b) => s + b.count, 0)).toBe(values.length);
    const byLabel = Object.fromEntries(bins.map((b) => [histogramBinLabel(b), b.count]));
    expect(byLabel).toEqual({
      '1.00x': 1,
      '1.01x–1.19x': 2,
      '1.20x–1.49x': 2,
      '1.50x–1.99x': 2,
      '2.00x–2.99x': 1,
      '3.00x–4.99x': 0,
      '5.00x–9.99x': 0,
      '10.00x–19.99x': 0,
      '20.00x–49.99x': 0,
      '50.00x–99.99x': 1,
      '≥ 100.00x': 2,
    });
    expect(bins.at(-1)).toMatchObject({ lowerX100: 10000, upperX100: null });
  });

  it('reports bin proportions against the dataset denominator', () => {
    const { bins } = computeHistogram(freq([100, 100, 300, 300]));
    expect(bins[0]!.proportion).toBe(0.5);
    expect(bins.find((b) => b.lowerX100 === 300)!.proportion).toBe(0.5);
  });

  it('returns zero counts and null proportions for an empty dataset', () => {
    const { denominator, bins } = computeHistogram([]);
    expect(denominator).toBe(0);
    expect(bins).toHaveLength(DEFAULT_HISTOGRAM_EDGES_X100.length);
    expect(bins.every((b) => b.count === 0 && b.proportion === null)).toBe(true);
  });

  it('supports custom edges but rejects edges that leave values uncovered or overlap', () => {
    expect(computeHistogram(freq([100, 250]), [100, 200]).bins.map((b) => b.count)).toEqual([1, 1]);
    expect(() => computeHistogram([], [101, 200])).toThrow(RangeError);
    expect(() => computeHistogram([], [100, 200, 200])).toThrow(RangeError);
  });
});

describe('frequency table validation', () => {
  it.each([
    [[{ multiplierX100: 99, count: 1 }]],
    [[{ multiplierX100: 150.5, count: 1 }]],
    [[{ multiplierX100: 150, count: 0 }]],
    [[{ multiplierX100: 150, count: 1.5 }]],
    [
      [
        { multiplierX100: 200, count: 1 },
        { multiplierX100: 150, count: 1 },
      ],
    ],
    [
      [
        { multiplierX100: 150, count: 1 },
        { multiplierX100: 150, count: 1 },
      ],
    ],
    [[{ multiplierX100: 150, count: MAX_ANALYTICS_ROUNDS + 1 }]],
  ])('rejects %j', (table) => {
    expect(() => computeAnalytics(table)).toThrow(RangeError);
  });
});

describe('computeAnalytics', () => {
  it('is deterministic for the same input', () => {
    const data = freq([100, 120, 135, 200, 450, 1200, 3000]);
    expect(computeAnalytics(data)).toEqual(computeAnalytics(data));
  });
});

describe('analyticsQuerySchema', () => {
  it('parses filters and thresholds into exact x100 values and UTC instants', () => {
    expect(
      analyticsQuerySchema.parse({
        source: ' my-log ',
        minMultiplier: '1.5',
        maxMultiplier: '10',
        eventFrom: '2026-01-01T01:00:00+01:00',
        eventTo: '2026-02-01T00:00:00Z',
        thresholds: '2, 1.5,2,10',
      }),
    ).toEqual({
      source: 'my-log',
      minMultiplier: 150,
      maxMultiplier: 1000,
      eventFrom: '2026-01-01T00:00:00.000Z',
      eventTo: '2026-02-01T00:00:00.000Z',
      thresholds: [150, 200, 1000],
    });
  });

  it.each([
    [{ thresholds: '2.345' }],
    [{ thresholds: '0.5' }],
    [{ thresholds: '' }],
    [{ thresholds: Array.from({ length: MAX_THRESHOLDS + 1 }, (_, i) => `${2 + i}`).join(',') }],
    [{ minMultiplier: '5', maxMultiplier: '2' }],
    [{ eventFrom: '2026-01-01' }],
    [{ eventFrom: '2026-01-01T00:00:00' }],
    [{ eventFrom: '2026-02-01T00:00:00Z', eventTo: '2026-01-01T00:00:00Z' }],
    [{ importId: '0' }],
    [{ unknown: 'x' }],
  ])('rejects %j', (query) => {
    expect(analyticsQuerySchema.safeParse(query).success).toBe(false);
  });
});

describe('cross-check against a naive sorted-array implementation', () => {
  /** Deterministic PRNG (mulberry32) so failures are reproducible. */
  function rng(seed: number): () => number {
    let a = seed >>> 0;
    return () => {
      a = (a + 0x6d2b79f5) >>> 0;
      let t = a;
      t = Math.imul(t ^ (t >>> 15), t | 1);
      t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
  }

  // Heavy-tailed synthetic values with many repeats and exact bin/threshold edges.
  function sample(next: () => number, n: number): number[] {
    const edges = [100, 101, 119, 120, 149, 150, 199, 200, 999, 1000, 9999, 10000];
    return Array.from({ length: n }, () => {
      const r = next();
      if (r < 0.15) return 100;
      if (r < 0.3) return edges[Math.floor(next() * edges.length)]!;
      return Math.min(100_000_000, Math.max(100, Math.floor(100 / (1 - next() * 0.99))));
    });
  }

  it.each([1, 2, 3, 7, 50, 999])('agrees for seed %i on random datasets', (seed) => {
    const next = rng(seed);
    for (let trial = 0; trial < 20; trial += 1) {
      const n = 1 + Math.floor(next() * 400);
      const values = sample(next, n).sort((a, b) => a - b);
      const result = computeAnalytics(freq(values), {
        thresholdsX100: [101, 120, 150, 200, 1000, 10000],
      });

      // Naive reference computed directly from the sorted raw values.
      const nearest = (bps: number) => values[Math.max(1, Math.ceil((bps * n) / 10000 - 1e-9)) - 1];
      expect(result.summary!.count).toBe(n);
      expect(result.summary!.minX100).toBe(values[0]);
      expect(result.summary!.maxX100).toBe(values[n - 1]);
      expect(result.summary!.meanX100).toBeCloseTo(values.reduce((s, v) => s + v, 0) / n, 2);
      expect(result.summary!.medianX100).toBe(nearest(5000));
      for (const q of result.summary!.quantiles) expect(q.valueX100).toBe(nearest(q.levelBps));
      for (const t of result.thresholds) {
        expect(t.count).toBe(values.filter((v) => v >= t.thresholdX100).length);
        expect(t.denominator).toBe(n);
      }
      for (const bin of result.histogram.bins) {
        expect(bin.count).toBe(
          values.filter((v) => v >= bin.lowerX100 && (bin.upperX100 === null || v < bin.upperX100))
            .length,
        );
      }
      expect(result.histogram.bins.reduce((s, b) => s + b.count, 0)).toBe(n);
    }
  });
});
