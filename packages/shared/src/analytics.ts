import { z } from 'zod';
import { MAX_SOURCE_LENGTH, parseIsoDateTimeWithOffset, parseMultiplierInput } from './rounds.js';
import {
  formatMultiplierX100,
  MAX_MULTIPLIER_X100,
  MIN_ROUND_MULTIPLIER_X100,
} from './multiplier.js';

/**
 * Descriptive analytics over stored historical rounds. Everything here DESCRIBES the
 * selected records; nothing predicts the next multiplier or evaluates a strategy.
 *
 * Input is a frequency table of exact x100 multipliers (value -> number of rounds),
 * typically produced by a SQL GROUP BY. Working on (value, count) pairs keeps memory
 * bounded by the number of distinct multipliers and keeps every statistic exact:
 * quantiles, thresholds and histogram counts are integer operations, and only the mean,
 * proportions and confidence bounds are floating point. Order of rounds is not used.
 */

export interface MultiplierFrequency {
  multiplierX100: number;
  count: number;
}

/** Default thresholds for P(M >= t): 1.20x, 1.50x, 2.00x, 3.00x, 5.00x, 10.00x, 20.00x. */
export const DEFAULT_THRESHOLDS_X100: readonly number[] = [120, 150, 200, 300, 500, 1000, 2000];
export const MAX_THRESHOLDS = 20;

/**
 * Default histogram edges (x100). Bin i covers lower <= M < upper (lower inclusive, upper
 * exclusive); the last bin is open-ended (M >= last edge), so the long tail is never
 * dropped or merged into a bounded bin. The first edge is the 1.00x domain minimum, so the
 * bins cover every valid multiplier. 1.00x gets its own bin because instant crashes are a
 * distinct, frequently studied outcome.
 */
export const DEFAULT_HISTOGRAM_EDGES_X100: readonly number[] = [
  100, 101, 120, 150, 200, 300, 500, 1000, 2000, 5000, 10000,
];

/** Quantile levels reported, in basis points (2500 = p25) to keep rank arithmetic exact. */
export const QUANTILE_LEVELS_BPS: readonly number[] = [2500, 5000, 7500, 9000, 9500, 9900];

/** Two-sided 95% standard-normal critical value used by the Wilson interval. */
export const WILSON_Z_95 = 1.959963984540054;

/** Upper bound on rounds analysed in one request (keeps sums far below 2^53). */
export const MAX_ANALYTICS_ROUNDS = 5_000_000;

/** Validates a frequency table: strictly ascending, in-domain values; positive integer counts. */
export function assertValidFrequencies(frequencies: readonly MultiplierFrequency[]): void {
  let previous = -1;
  let total = 0;
  for (const { multiplierX100, count } of frequencies) {
    if (
      !Number.isSafeInteger(multiplierX100) ||
      multiplierX100 < MIN_ROUND_MULTIPLIER_X100 ||
      multiplierX100 > MAX_MULTIPLIER_X100
    ) {
      throw new RangeError(`Invalid multiplier value ${multiplierX100} in frequency table`);
    }
    if (multiplierX100 <= previous) {
      throw new RangeError('Frequency table must be strictly ascending by multiplier');
    }
    if (!Number.isSafeInteger(count) || count < 1) {
      throw new RangeError(`Invalid count ${count} in frequency table`);
    }
    total += count;
    previous = multiplierX100;
  }
  if (total > MAX_ANALYTICS_ROUNDS) {
    throw new RangeError(`Frequency table covers more than ${MAX_ANALYTICS_ROUNDS} rounds`);
  }
}

function totalCount(frequencies: readonly MultiplierFrequency[]): number {
  return frequencies.reduce((sum, f) => sum + f.count, 0);
}

/**
 * Nearest-rank quantile (inverse empirical CDF; Hyndman & Fan type 1): the smallest
 * observed value v with at least ceil(p * n) observations <= v (rank 1 for p = 0).
 * Always an observed multiplier, so it is exact and never interpolated or rounded.
 */
export function nearestRankQuantileX100(
  frequencies: readonly MultiplierFrequency[],
  levelBps: number,
): number | null {
  if (!Number.isInteger(levelBps) || levelBps < 0 || levelBps > 10_000) {
    throw new RangeError(`Quantile level must be 0..10000 basis points, got ${levelBps}`);
  }
  const n = totalCount(frequencies);
  if (n === 0) return null;
  // ceil(levelBps * n / 10000) in exact integer arithmetic.
  const rank = Math.max(1, Math.floor((levelBps * n + 9_999) / 10_000));
  let cumulative = 0;
  for (const f of frequencies) {
    cumulative += f.count;
    if (cumulative >= rank) return f.multiplierX100;
  }
  return frequencies[frequencies.length - 1]!.multiplierX100;
}

export interface WilsonInterval {
  lower: number;
  upper: number;
}

/**
 * Wilson score interval for a binomial proportion (Wilson, 1927). Returns null when
 * n = 0: no interval is reported for an empty denominator. Bounds are exact at the edges
 * (lower = 0 when successes = 0, upper = 1 when successes = n) and clamped to [0, 1].
 */
export function wilsonInterval(
  successes: number,
  n: number,
  z: number = WILSON_Z_95,
): WilsonInterval | null {
  if (!Number.isSafeInteger(n) || n < 0 || !Number.isSafeInteger(successes)) {
    throw new RangeError('Wilson interval needs integer successes and n');
  }
  if (successes < 0 || successes > n) throw new RangeError('successes must be between 0 and n');
  if (!(z > 0) || !Number.isFinite(z)) throw new RangeError('z must be a positive finite number');
  if (n === 0) return null;
  const p = successes / n;
  const z2 = z * z;
  const denominator = 1 + z2 / n;
  const centre = (p + z2 / (2 * n)) / denominator;
  const half = (z * Math.sqrt((p * (1 - p)) / n + z2 / (4 * n * n))) / denominator;
  return {
    lower: successes === 0 ? 0 : Math.max(0, centre - half),
    upper: successes === n ? 1 : Math.min(1, centre + half),
  };
}

export interface AnalyticsSummary {
  count: number;
  minX100: number;
  maxX100: number;
  /** Arithmetic mean in x100 units, rounded to 2 decimals (i.e. 0.0001x). */
  meanX100: number;
  /** Nearest-rank p50: for an even count this is the lower of the two middle values. */
  medianX100: number;
  quantiles: { levelBps: number; valueX100: number }[];
}

export function computeSummary(
  frequencies: readonly MultiplierFrequency[],
): AnalyticsSummary | null {
  assertValidFrequencies(frequencies);
  const n = totalCount(frequencies);
  if (n === 0) return null;
  // Max value 1e8 x MAX_ANALYTICS_ROUNDS 5e6 = 5e14 < 2^53, so the sum is exact.
  const sum = frequencies.reduce((acc, f) => acc + f.multiplierX100 * f.count, 0);
  return {
    count: n,
    minX100: frequencies[0]!.multiplierX100,
    maxX100: frequencies[frequencies.length - 1]!.multiplierX100,
    meanX100: Math.round((sum / n) * 100) / 100,
    medianX100: nearestRankQuantileX100(frequencies, 5000)!,
    quantiles: QUANTILE_LEVELS_BPS.map((levelBps) => ({
      levelBps,
      valueX100: nearestRankQuantileX100(frequencies, levelBps)!,
    })),
  };
}

export interface ThresholdResult {
  thresholdX100: number;
  /** Rounds with multiplier >= threshold. */
  count: number;
  /** Rounds in the selected dataset. */
  denominator: number;
  /** count / denominator, or null when the denominator is 0. */
  proportion: number | null;
  /** 95% Wilson score interval for the proportion, or null when the denominator is 0. */
  ci95: WilsonInterval | null;
}

/** Normalises thresholds: integers within the multiplier domain, de-duplicated, ascending. */
export function normaliseThresholds(thresholdsX100: readonly number[]): number[] {
  for (const t of thresholdsX100) {
    if (!Number.isSafeInteger(t) || t < MIN_ROUND_MULTIPLIER_X100 || t > MAX_MULTIPLIER_X100) {
      throw new RangeError(`Invalid threshold ${t}`);
    }
  }
  const unique = [...new Set(thresholdsX100)].sort((a, b) => a - b);
  if (unique.length > MAX_THRESHOLDS) {
    throw new RangeError(`At most ${MAX_THRESHOLDS} thresholds are supported`);
  }
  return unique;
}

/** Empirical survival: for each threshold t, the observed proportion of rounds with M >= t. */
export function computeThresholds(
  frequencies: readonly MultiplierFrequency[],
  thresholdsX100: readonly number[] = DEFAULT_THRESHOLDS_X100,
): ThresholdResult[] {
  assertValidFrequencies(frequencies);
  const n = totalCount(frequencies);
  return normaliseThresholds(thresholdsX100).map((thresholdX100) => {
    const count = frequencies
      .filter((f) => f.multiplierX100 >= thresholdX100)
      .reduce((sum, f) => sum + f.count, 0);
    return {
      thresholdX100,
      count,
      denominator: n,
      proportion: n === 0 ? null : count / n,
      ci95: wilsonInterval(count, n),
    };
  });
}

export interface HistogramBin {
  /** Inclusive lower bound (x100). */
  lowerX100: number;
  /** Exclusive upper bound (x100), or null for the open-ended last bin. */
  upperX100: number | null;
  count: number;
  /** count / denominator, or null when the denominator is 0. */
  proportion: number | null;
}

export interface Histogram {
  denominator: number;
  bins: HistogramBin[];
}

export function assertValidHistogramEdges(edgesX100: readonly number[]): void {
  if (edgesX100.length < 1 || edgesX100[0] !== MIN_ROUND_MULTIPLIER_X100) {
    throw new RangeError('Histogram edges must start at the 1.00x domain minimum (100)');
  }
  edgesX100.forEach((edge, i) => {
    if (!Number.isSafeInteger(edge) || edge > MAX_MULTIPLIER_X100) {
      throw new RangeError(`Invalid histogram edge ${edge}`);
    }
    if (i > 0 && edge <= edgesX100[i - 1]!) {
      throw new RangeError('Histogram edges must be strictly ascending');
    }
  });
}

/** Bins are [edge_i, edge_{i+1}) with the last bin [edge_last, infinity). Every round lands in exactly one bin. */
export function computeHistogram(
  frequencies: readonly MultiplierFrequency[],
  edgesX100: readonly number[] = DEFAULT_HISTOGRAM_EDGES_X100,
): Histogram {
  assertValidFrequencies(frequencies);
  assertValidHistogramEdges(edgesX100);
  const n = totalCount(frequencies);
  const bins: HistogramBin[] = edgesX100.map((lowerX100, i) => ({
    lowerX100,
    upperX100: edgesX100[i + 1] ?? null,
    count: 0,
    proportion: null,
  }));
  let binIndex = 0;
  for (const f of frequencies) {
    while (binIndex < bins.length - 1 && f.multiplierX100 >= bins[binIndex]!.upperX100!) {
      binIndex += 1;
    }
    bins[binIndex]!.count += f.count;
  }
  for (const bin of bins) bin.proportion = n === 0 ? null : bin.count / n;
  return { denominator: n, bins };
}

/**
 * Human label for a bin over the integer x100 domain: [101, 120) covers 1.01x..1.19x
 * exactly, so it is labelled "1.01x–1.19x"; a one-value bin is "1.00x"; the open last
 * bin is "≥ 100.00x".
 */
export function histogramBinLabel(bin: Pick<HistogramBin, 'lowerX100' | 'upperX100'>): string {
  if (bin.upperX100 === null) return `≥ ${formatMultiplierX100(bin.lowerX100)}`;
  if (bin.upperX100 - bin.lowerX100 === 1) return formatMultiplierX100(bin.lowerX100);
  return `${formatMultiplierX100(bin.lowerX100)}–${formatMultiplierX100(bin.upperX100 - 1)}`;
}

export interface AnalyticsResult {
  summary: AnalyticsSummary | null;
  thresholds: ThresholdResult[];
  histogram: Histogram;
}

export function computeAnalytics(
  frequencies: readonly MultiplierFrequency[],
  options: { thresholdsX100?: readonly number[]; histogramEdgesX100?: readonly number[] } = {},
): AnalyticsResult {
  return {
    summary: computeSummary(frequencies),
    thresholds: computeThresholds(frequencies, options.thresholdsX100 ?? DEFAULT_THRESHOLDS_X100),
    histogram: computeHistogram(
      frequencies,
      options.histogramEdgesX100 ?? DEFAULT_HISTOGRAM_EDGES_X100,
    ),
  };
}

// ---------------------------------------------------------------------------
// API contracts
// ---------------------------------------------------------------------------

const optionalMultiplierText = z
  .string()
  .transform((text, ctx) => {
    const parsed = parseMultiplierInput(text);
    if (!parsed.ok) {
      ctx.addIssue({ code: 'custom', message: parsed.issue.message });
      return z.NEVER;
    }
    return parsed.value;
  })
  .optional();

const optionalInstant = z
  .string()
  .transform((text, ctx) => {
    const instant = parseIsoDateTimeWithOffset(text.trim());
    if (typeof instant !== 'number') {
      ctx.addIssue({
        code: 'custom',
        message: 'must be an ISO-8601 date-time with an explicit offset, e.g. 2026-01-31T00:00:00Z',
      });
      return z.NEVER;
    }
    return new Date(instant).toISOString();
  })
  .optional();

/** "1.5,2,10" -> [150, 200, 1000] using the same multiplier rules as round input. */
const thresholdListText = z
  .string()
  .transform((text, ctx) => {
    const parts = text.split(',').map((p) => p.trim());
    const values: number[] = [];
    for (const part of parts) {
      const parsed = parseMultiplierInput(part);
      if (!parsed.ok) {
        ctx.addIssue({ code: 'custom', message: `threshold: ${parsed.issue.message}` });
        return z.NEVER;
      }
      values.push(parsed.value);
    }
    const unique = [...new Set(values)].sort((a, b) => a - b);
    if (unique.length > MAX_THRESHOLDS) {
      ctx.addIssue({
        code: 'custom',
        message: `at most ${MAX_THRESHOLDS} thresholds are supported`,
      });
      return z.NEVER;
    }
    return unique;
  })
  .optional();

/**
 * GET /api/analytics query. Filters match the round browser where they overlap. eventFrom
 * is inclusive and eventTo exclusive; when either is set, rounds WITHOUT an event time
 * cannot be placed in the range and are excluded (and counted in dataset.exclusions).
 */
export const analyticsQuerySchema = z
  .object({
    source: z.string().trim().min(1).max(MAX_SOURCE_LENGTH).optional(),
    importId: z.coerce.number().int().positive().optional(),
    minMultiplier: optionalMultiplierText,
    maxMultiplier: optionalMultiplierText,
    eventFrom: optionalInstant,
    eventTo: optionalInstant,
    thresholds: thresholdListText,
  })
  .strict()
  .refine(
    (q) =>
      q.minMultiplier === undefined ||
      q.maxMultiplier === undefined ||
      q.minMultiplier <= q.maxMultiplier,
    { message: 'minMultiplier must not exceed maxMultiplier', path: ['minMultiplier'] },
  )
  .refine((q) => q.eventFrom === undefined || q.eventTo === undefined || q.eventFrom < q.eventTo, {
    message: 'eventFrom must be earlier than eventTo',
    path: ['eventFrom'],
  });
export type AnalyticsQuery = z.infer<typeof analyticsQuerySchema>;

const wilsonSchema = z.object({ lower: z.number().min(0).max(1), upper: z.number().min(0).max(1) });
const proportionSchema = z.number().min(0).max(1).nullable();

export const ANALYTICS_EXCLUSION_REASONS = [
  'synthetic_test_fixture',
  'no_event_time_with_date_filter',
] as const;

export const analyticsResponseSchema = z.object({
  dataset: z.object({
    filters: z.object({
      source: z.string().nullable(),
      importId: z.number().int().nullable(),
      minMultiplierX100: z.number().int().nullable(),
      maxMultiplierX100: z.number().int().nullable(),
      eventFrom: z.string().nullable(),
      eventTo: z.string().nullable(),
    }),
    /** The denominator for every proportion in this response. */
    roundsIncluded: z.number().int().min(0),
    distinctSources: z.number().int().min(0),
    eventTime: z.object({
      withEventAt: z.number().int().min(0),
      withoutEventAt: z.number().int().min(0),
      earliestEventAt: z.string().nullable(),
      latestEventAt: z.string().nullable(),
    }),
    exclusions: z.array(
      z.object({
        reason: z.enum(ANALYTICS_EXCLUSION_REASONS),
        count: z.number().int().min(0),
        description: z.string(),
      }),
    ),
  }),
  summary: z
    .object({
      count: z.number().int().min(1),
      minX100: z.number().int(),
      maxX100: z.number().int(),
      meanX100: z.number(),
      medianX100: z.number().int(),
      quantiles: z.array(z.object({ levelBps: z.number().int(), valueX100: z.number().int() })),
    })
    .nullable(),
  thresholds: z.array(
    z.object({
      thresholdX100: z.number().int(),
      count: z.number().int().min(0),
      denominator: z.number().int().min(0),
      proportion: proportionSchema,
      ci95: wilsonSchema.nullable(),
    }),
  ),
  histogram: z.object({
    denominator: z.number().int().min(0),
    bins: z.array(
      z.object({
        lowerX100: z.number().int(),
        upperX100: z.number().int().nullable(),
        count: z.number().int().min(0),
        proportion: proportionSchema,
      }),
    ),
  }),
  method: z.object({
    quantile: z.literal('nearest_rank'),
    thresholdRule: z.literal('multiplier >= threshold'),
    interval: z.literal('wilson_score'),
    confidenceLevel: z.literal(0.95),
    histogramBins: z.literal('lower <= multiplier < upper; last bin open-ended'),
    ordering: z.literal('order_independent'),
  }),
});
export type AnalyticsResponse = z.infer<typeof analyticsResponseSchema>;

export const ANALYTICS_METHOD: AnalyticsResponse['method'] = {
  quantile: 'nearest_rank',
  thresholdRule: 'multiplier >= threshold',
  interval: 'wilson_score',
  confidenceLevel: 0.95,
  histogramBins: 'lower <= multiplier < upper; last bin open-ended',
  ordering: 'order_independent',
};
