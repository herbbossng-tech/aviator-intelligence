import { z } from 'zod';
import {
  createSummaryReplayer,
  MAX_BACKTEST_ROUNDS,
  STOP_REASONS,
  type BacktestSummary,
  type StopReason,
} from './backtest.js';
import type { TwoLegStrategyConfig } from './legs.js';
import { roundMultiplierX100Schema } from './multiplier.js';
import type { SimulationSettings } from './simulation.js';

/**
 * Uncertainty analysis of a completed virtual backtest by IID empirical bootstrap.
 *
 * VIRTUAL MONEY ONLY. This is a sensitivity analysis of one configuration against the
 * observed multipliers of one historical sample. It is not a prediction, not an
 * unconditional probability of any real-world outcome, and not evidence of profitability.
 *
 * Method (see docs/UNCERTAINTY.md):
 * - The sample is the n eligible multipliers of the run's dataset (one source; the existing
 *   eligibility rules; synthetic and undated rounds excluded).
 * - Each path draws n multipliers independently and uniformly WITH replacement from the
 *   sample (an IID bootstrap: it assumes rounds are independent and identically
 *   distributed, and discards their order).
 * - Each path is replayed from the run's starting bankroll with the run's own strategy and
 *   settings, through the same replay loop as the historical backtest (createSummaryReplayer).
 *   Paths share nothing: every path starts again from the starting bankroll.
 * - Randomness comes only from xoshiro128** seeded per path from (seed, path index), so
 *   results are reproducible from the seed, the sample (fingerprinted) and this version.
 */
export const BOOTSTRAP_ALGORITHM_VERSION = 'iid-bootstrap/xoshiro128ss-fmix32/v1';

export const MAX_ANALYSIS_PATHS = 2_000;
export const DEFAULT_ANALYSIS_PATHS = 500;
/** Upper bound on paths x path length (replayed rounds), checked before any computation. */
export const MAX_ANALYSIS_ROUND_STEPS = 2_000_000;
/** Below this many observed rounds the result carries a small-sample warning. */
export const SMALL_SAMPLE_ROUNDS = 100;
/** Below this many paths the outer quantiles are coarse; the result carries a warning. */
export const FEW_PATHS = 200;
/** Seeds are non-negative safe integers (53 bits). */
export const MAX_ANALYSIS_SEED = Number.MAX_SAFE_INTEGER;
/** p05, p25, p50 (median), p75, p95 of the per-path values; nearest-rank. */
export const ANALYSIS_QUANTILE_LEVELS_BPS: readonly number[] = [500, 2500, 5000, 7500, 9500];

/** Thrown before any computation when a request exceeds the analysis work limits. */
export class AnalysisLimitError extends RangeError {
  constructor(message: string) {
    super(message);
    this.name = 'AnalysisLimitError';
  }
}

// ---------------------------------------------------------------------------
// Seeded pseudo-random numbers
// ---------------------------------------------------------------------------

/** MurmurHash3's 32-bit finaliser: a bijection on uint32 that mixes all bits. */
export function fmix32(value: number): number {
  let h = value >>> 0;
  h ^= h >>> 16;
  h = Math.imul(h, 0x85ebca6b);
  h ^= h >>> 13;
  h = Math.imul(h, 0xc2b2ae35);
  h ^= h >>> 16;
  return h >>> 0;
}

const rotl = (x: number, k: number) => ((x << k) | (x >>> (32 - k))) >>> 0;

/** xoshiro128** 1.1 (Blackman & Vigna): 128-bit state, 32-bit outputs. */
export class Xoshiro128StarStar {
  private readonly s: Uint32Array;

  constructor(state: readonly [number, number, number, number]) {
    this.s = Uint32Array.from(state);
    if (this.s.every((w) => w === 0)) {
      throw new RangeError('xoshiro128** state must not be all zero');
    }
  }

  /** Next uniformly distributed uint32. */
  next(): number {
    const s = this.s;
    const s0 = s[0]!;
    const s1 = s[1]!;
    const result = Math.imul(rotl(Math.imul(s1, 5) >>> 0, 7), 9) >>> 0;
    const t = (s1 << 9) >>> 0;
    const s2 = (s[2]! ^ s0) >>> 0;
    const s3 = (s[3]! ^ s1) >>> 0;
    s[1] = s1 ^ s2;
    s[0] = s0 ^ s3;
    s[2] = s2 ^ t;
    s[3] = rotl(s3, 11);
    return result;
  }

  /**
   * Uniform integer in [0, n) without modulo bias: draws below the largest multiple of n
   * that fits in 2^32 are accepted, the rest rejected and redrawn.
   */
  nextIndex(n: number): number {
    if (!Number.isInteger(n) || n < 1 || n > 0x1_0000_0000) {
      throw new RangeError(`n must be an integer in 1..2^32, got ${n}`);
    }
    const limit = 0x1_0000_0000 - (0x1_0000_0000 % n);
    for (;;) {
      const x = this.next();
      if (x < limit) return x % n;
    }
  }
}

const WARM_UP_DRAWS = 16;

/**
 * The generator for one path. The seed's low and high 32-bit words and the path index each
 * pass through fmix32 (a bijection) into separate state words, so distinct (seed, path)
 * pairs always start from distinct states; 16 warm-up draws then decorrelate nearby states.
 */
export function pathGenerator(seed: number, pathIndex: number): Xoshiro128StarStar {
  if (!Number.isSafeInteger(seed) || seed < 0) {
    throw new RangeError('The seed must be a non-negative safe integer');
  }
  if (!Number.isInteger(pathIndex) || pathIndex < 0 || pathIndex > 0xffff_ffff) {
    throw new RangeError('The path index must be a uint32');
  }
  const lo = seed % 0x1_0000_0000;
  const hi = Math.floor(seed / 0x1_0000_0000);
  const s0 = fmix32(lo ^ 0x9e3779b9);
  const s1 = fmix32(hi ^ 0x243f6a88);
  const s2 = fmix32(pathIndex ^ 0xb7e15162);
  // Never all zero: s3 is non-zero whenever s0..s2 are all zero.
  const s3 = fmix32((s0 ^ s1 ^ s2 ^ 0x6a09e667) >>> 0) || 1;
  const rng = new Xoshiro128StarStar([s0, s1, s2, s3]);
  for (let i = 0; i < WARM_UP_DRAWS; i++) rng.next();
  return rng;
}

// ---------------------------------------------------------------------------
// Statistics helpers
// ---------------------------------------------------------------------------

/**
 * Nearest-rank quantile (Hyndman & Fan type 1) of an ascending array: the smallest value
 * with at least ceil(p * n) values <= it. Always one of the values (no interpolation), the
 * same convention as the historical analytics.
 */
export function nearestRankSorted(sortedAscending: ArrayLike<number>, levelBps: number): number {
  const n = sortedAscending.length;
  if (n === 0) throw new RangeError('Cannot take a quantile of an empty array');
  if (!Number.isInteger(levelBps) || levelBps < 0 || levelBps > 10_000) {
    throw new RangeError(`Quantile level must be 0..10000 basis points, got ${levelBps}`);
  }
  const rank = Math.max(1, Math.ceil((levelBps * n) / 10_000));
  return sortedAscending[rank - 1]!;
}

function distribution(values: Float64Array) {
  const sorted = Float64Array.from(values).sort();
  return {
    min: sorted[0]!,
    max: sorted[sorted.length - 1]!,
    quantiles: ANALYSIS_QUANTILE_LEVELS_BPS.map((levelBps) => ({
      levelBps,
      value: nearestRankSorted(sorted, levelBps),
    })),
  };
}

// ---------------------------------------------------------------------------
// Bootstrap
// ---------------------------------------------------------------------------

export interface BootstrapOptions {
  paths: number;
  seed: number;
}

export const analysisSettingsSchema = z
  .object({
    paths: z.number().int().min(1).max(MAX_ANALYSIS_PATHS),
    seed: z.number().int().min(0).max(MAX_ANALYSIS_SEED),
  })
  .strict();
export type AnalysisSettings = z.infer<typeof analysisSettingsSchema>;

/** Paths x path length must stay within MAX_ANALYSIS_ROUND_STEPS. */
export function maxPathsForSample(sampleSize: number): number {
  return Math.max(
    0,
    Math.min(MAX_ANALYSIS_PATHS, Math.floor(MAX_ANALYSIS_ROUND_STEPS / sampleSize)),
  );
}

const distributionSchema = z.object({
  min: z.number(),
  max: z.number(),
  quantiles: z.array(z.object({ levelBps: z.number().int(), value: z.number() })),
});

const countWithDenominator = z.object({
  count: z.number().int().min(0),
  denominator: z.number().int().min(1),
});

export const ANALYSIS_WARNING_CODES = [
  'small_sample',
  'degenerate_sample',
  'few_distinct_multipliers',
  'few_paths',
] as const;

export const bootstrapSummarySchema = z.object({
  algorithmVersion: z.string(),
  seed: z.number().int(),
  paths: z.number().int().min(1),
  sample: z.object({
    /** n: the number of observed historical multipliers resampled from. */
    size: z.number().int().min(1),
    distinctMultipliers: z.number().int().min(1),
    minMultiplierX100: z.number().int(),
    maxMultiplierX100: z.number().int(),
  }),
  /** Every path draws this many multipliers (= sample size). */
  pathLength: z.number().int().min(1),
  /** How each path ended; the counts sum to `paths`. */
  stopReasons: z.record(z.enum(STOP_REASONS), z.number().int().min(0)),
  endingBankrollMinor: distributionSchema,
  netOutcome: z.object({
    positive: z.number().int().min(0),
    zero: z.number().int().min(0),
    negative: z.number().int().min(0),
    denominator: z.number().int().min(1),
  }),
  maxDrawdownFraction: distributionSchema,
  maxDrawdownMinor: distributionSchema,
  roundsReplayed: distributionSchema,
  /**
   * Paths that ENDED because of a configured stop, or null when that stop is not configured
   * (no boundary is invented).
   */
  configuredBoundaries: z.object({
    lowerBankrollStop: countWithDenominator.extend({ thresholdMinor: z.number().int() }).nullable(),
    maxDrawdownStop: countWithDenominator.extend({ thresholdBps: z.number().int() }).nullable(),
  }),
  /** Where the observed historical run sits among the resampled paths. */
  observed: z.object({
    endingBankrollMinor: z.number().int(),
    maxDrawdownFraction: z.number(),
    stopReason: z.enum(STOP_REASONS),
    pathsEndingBelow: z.number().int().min(0),
    pathsEndingEqual: z.number().int().min(0),
    pathsEndingAbove: z.number().int().min(0),
    denominator: z.number().int().min(1),
  }),
  warnings: z.array(z.object({ code: z.enum(ANALYSIS_WARNING_CODES), message: z.string() })),
});
export type BootstrapSummary = z.infer<typeof bootstrapSummarySchema>;

/**
 * Runs the bootstrap. `sample` is the run's eligible multipliers in replay order (the order
 * fixes which index maps to which value, so the dataset fingerprint covers it). `observed`
 * is the historical run's own summary, for comparison only. Throws AnalysisLimitError
 * before computing anything if the request is too large, and BacktestLimitError if exact
 * results would leave the safe integer range.
 */
export function runBootstrap(
  sample: readonly number[],
  strategy: TwoLegStrategyConfig,
  settings: SimulationSettings,
  options: BootstrapOptions,
  observed: Pick<BacktestSummary, 'endingBankrollMinor' | 'maxDrawdownFraction' | 'stopReason'>,
): BootstrapSummary {
  const { paths, seed } = analysisSettingsSchema.parse(options);
  const n = sample.length;
  if (n === 0) throw new AnalysisLimitError('The sample is empty; there is nothing to resample.');
  if (n > MAX_BACKTEST_ROUNDS) {
    throw new AnalysisLimitError(`The sample exceeds ${MAX_BACKTEST_ROUNDS} rounds.`);
  }
  if (paths * n > MAX_ANALYSIS_ROUND_STEPS) {
    throw new AnalysisLimitError(
      `${paths} paths of ${n} rounds is ${paths * n} replayed rounds; the limit is ${MAX_ANALYSIS_ROUND_STEPS}. Use at most ${maxPathsForSample(n)} paths for this sample.`,
    );
  }
  for (const m of sample) roundMultiplierX100Schema.parse(m);
  const replay = createSummaryReplayer(strategy, settings);

  const endings = new Float64Array(paths);
  const ddFraction = new Float64Array(paths);
  const ddMinor = new Float64Array(paths);
  const replayedCounts = new Float64Array(paths);
  const stopReasons = Object.fromEntries(STOP_REASONS.map((r) => [r, 0])) as Record<
    StopReason,
    number
  >;
  let positive = 0;
  let zero = 0;
  let negative = 0;
  const buffer = new Int32Array(n);
  for (let p = 0; p < paths; p++) {
    const rng = pathGenerator(seed, p);
    for (let i = 0; i < n; i++) buffer[i] = sample[rng.nextIndex(n)]!;
    const summary = replay(buffer);
    endings[p] = summary.endingBankrollMinor;
    ddFraction[p] = summary.maxDrawdownFraction;
    ddMinor[p] = summary.maxDrawdownMinor;
    replayedCounts[p] = summary.roundsReplayed;
    stopReasons[summary.stopReason] += 1;
    if (summary.netProfitMinor > 0) positive += 1;
    else if (summary.netProfitMinor < 0) negative += 1;
    else zero += 1;
  }

  const distinct = new Set(sample);
  const warnings: BootstrapSummary['warnings'] = [];
  if (distinct.size === 1) {
    warnings.push({
      code: 'degenerate_sample',
      message:
        'Every observed multiplier is identical, so every resampled path is identical and the spread shown is zero. This reflects the sample, not certainty.',
    });
  } else if (distinct.size < 10) {
    warnings.push({
      code: 'few_distinct_multipliers',
      message: `The sample has only ${distinct.size} distinct multipliers; resampled paths can only combine those values.`,
    });
  }
  if (n < SMALL_SAMPLE_ROUNDS) {
    warnings.push({
      code: 'small_sample',
      message: `Only ${n} observed rounds. The bootstrap cannot add information beyond these ${n} observations; with so few, the resampled spread itself is unreliable.`,
    });
  }
  if (paths < FEW_PATHS) {
    warnings.push({
      code: 'few_paths',
      message: `Only ${paths} paths: the p05 and p95 values rest on very few paths and will move noticeably with another seed.`,
    });
  }

  const { risk } = settings;
  let below = 0;
  let equal = 0;
  for (const e of endings) {
    if (e < observed.endingBankrollMinor) below += 1;
    else if (e === observed.endingBankrollMinor) equal += 1;
  }

  const sortedSample = [...distinct].sort((a, b) => a - b);
  return {
    algorithmVersion: BOOTSTRAP_ALGORITHM_VERSION,
    seed,
    paths,
    sample: {
      size: n,
      distinctMultipliers: distinct.size,
      minMultiplierX100: sortedSample[0]!,
      maxMultiplierX100: sortedSample[sortedSample.length - 1]!,
    },
    pathLength: n,
    stopReasons,
    endingBankrollMinor: distribution(endings),
    netOutcome: { positive, zero, negative, denominator: paths },
    maxDrawdownFraction: distribution(ddFraction),
    maxDrawdownMinor: distribution(ddMinor),
    roundsReplayed: distribution(replayedCounts),
    configuredBoundaries: {
      lowerBankrollStop:
        risk.stopBelowBankrollMinor === null
          ? null
          : {
              thresholdMinor: risk.stopBelowBankrollMinor,
              count: stopReasons.stop_below,
              denominator: paths,
            },
      maxDrawdownStop:
        risk.maxDrawdownBps === null
          ? null
          : {
              thresholdBps: risk.maxDrawdownBps,
              count: stopReasons.max_drawdown,
              denominator: paths,
            },
    },
    observed: {
      endingBankrollMinor: observed.endingBankrollMinor,
      maxDrawdownFraction: observed.maxDrawdownFraction,
      stopReason: observed.stopReason,
      pathsEndingBelow: below,
      pathsEndingEqual: equal,
      pathsEndingAbove: paths - below - equal,
      denominator: paths,
    },
    warnings,
  };
}

// ---------------------------------------------------------------------------
// API contracts
// ---------------------------------------------------------------------------

export const analysisRequestSchema = analysisSettingsSchema;

export const simulationAnalysisDtoSchema = z.object({
  id: z.number().int(),
  simulationRunId: z.number().int(),
  status: z.literal('completed'),
  createdAt: z.string(),
  completedAt: z.string(),
  algorithmVersion: z.string(),
  seed: z.number().int(),
  paths: z.number().int(),
  datasetSha256: z.string(),
  summary: bootstrapSummarySchema,
});
export type SimulationAnalysisDto = z.infer<typeof simulationAnalysisDtoSchema>;

export const simulationAnalysesListSchema = z.object({
  items: z.array(simulationAnalysisDtoSchema),
  total: z.number().int(),
  /** Largest path count allowed for this run's sample under the work limit. */
  maxPaths: z.number().int(),
  sampleSize: z.number().int().nullable(),
});
