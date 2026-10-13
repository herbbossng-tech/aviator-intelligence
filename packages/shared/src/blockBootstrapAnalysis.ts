import { z } from 'zod';
import {
  createSummaryReplayer,
  MAX_BACKTEST_ROUNDS,
  STOP_REASONS,
  type BacktestSummary,
  type StopReason,
} from './backtest.js';
import {
  blockPathGenerator,
  blockPathIndices,
  drawBlockStarts,
  MOVING_BLOCK_ALGORITHM_VERSION,
  movingBlockLayout,
  type MovingBlockLayout,
} from './blockBootstrap.js';
import {
  ANALYSIS_QUANTILE_LEVELS_BPS,
  ANALYSIS_WARNING_CODES,
  AnalysisLimitError,
  analysisSettingsSchema,
  bootstrapSummarySchema,
  FEW_PATHS,
  MAX_ANALYSIS_ROUND_STEPS,
  maxPathsForSample,
  nearestRankSorted,
  SMALL_SAMPLE_ROUNDS,
} from './bootstrap.js';
import { LEG_KEYS, type LegKey, type TwoLegStrategyConfig } from './legs.js';
import { roundMultiplierX100Schema } from './multiplier.js';
import type { SimulationSettings } from './simulation.js';
import { stakingIdentity, type StakingPlan } from './staking.js';

/**
 * Moving-block bootstrap analysis of a completed virtual backtest (progression increment 4,
 * step 2). See docs/BLOCK_BOOTSTRAP_DESIGN.md.
 *
 * VIRTUAL MONEY ONLY. A sensitivity analysis of one configuration against one recorded
 * sample: not a prediction, not a real-world probability, not evidence of profitability, and
 * not a test of whether rounds depend on each other.
 *
 * Each path is built by the step 1 sampler (blockBootstrap.ts): ⌈n/b⌉ stretches of b rounds
 * that are consecutive in the recorded sample (a stretch may span a gap in the recording),
 * joined in draw order and truncated to n rounds. The path's multipliers are then replayed
 * by the canonical replay loop (createSummaryReplayer → replayCore), exactly as an IID path
 * is: the staking plan is validated and compiled once, and every path starts from the
 * configured bankroll with every progression afresh. Legs A and B keep independent state.
 *
 * The IID bootstrap (bootstrap.ts) is not changed: its sampling, random stream, results and
 * version are untouched. This engine reuses its exported limits, quantile rule and summary
 * sub-schemas so the two results are directly comparable.
 */

/** The IID warnings, plus one specific to blocks. */
export const BLOCK_ANALYSIS_WARNING_CODES = [
  ...ANALYSIS_WARNING_CODES,
  'few_candidate_blocks',
] as const;
/** Below this many candidate stretches (S = n − b + 1), paths reuse the same ones heavily. */
export const FEW_CANDIDATE_BLOCKS = 100;

export const blockAnalysisSettingsSchema = z
  .object({
    paths: analysisSettingsSchema.shape.paths,
    seed: analysisSettingsSchema.shape.seed,
    blockLength: z.number().int(),
  })
  .strict();
export type BlockAnalysisSettings = z.infer<typeof blockAnalysisSettingsSchema>;

const distributionSchema = bootstrapSummarySchema.shape.endingBankrollMinor;

export const blockBootstrapSummarySchema = bootstrapSummarySchema.omit({ warnings: true }).extend({
  /** How every path was cut into blocks (identical for all paths of an analysis). */
  resampling: z
    .object({
      method: z.literal('moving_block'),
      blockLength: z.number().int().min(2),
      blocksPerPath: z.number().int().min(1),
      lastBlockLength: z.number().int().min(1),
      candidateStarts: z.number().int().min(1),
    })
    .strict(),
  /**
   * Per path, the longest run of consecutive replayed rounds whose round net was negative
   * (the replay summary's longestLosingStreak; a break-even round ends a run). Reported
   * because keeping recorded order changes it most. Not reported by the IID bootstrap.
   */
  longestLosingStreak: distributionSchema,
  warnings: z.array(z.object({ code: z.enum(BLOCK_ANALYSIS_WARNING_CODES), message: z.string() })),
});
export type BlockBootstrapSummary = z.infer<typeof blockBootstrapSummarySchema>;

function distribution(values: Float64Array): z.infer<typeof distributionSchema> {
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

/**
 * Runs the moving-block bootstrap. `sample` is the run's eligible multipliers in replay order;
 * `observed` is the historical run's own summary, for comparison only; `staking` is the run's
 * stored plan (null for flat stakes), never a default.
 *
 * Everything is validated before any path is drawn: the paths and seed (ZodError, as for the
 * IID bootstrap), the sample size and block length (BlockBootstrapError), the work limit
 * (AnalysisLimitError), every multiplier, and the strategy, settings and plan. BacktestLimitError
 * is thrown if exact results would leave the safe integer range.
 */
export function runBlockBootstrap(
  sample: readonly number[],
  strategy: TwoLegStrategyConfig,
  settings: SimulationSettings,
  options: BlockAnalysisSettings,
  observed: Pick<
    BacktestSummary,
    | 'endingBankrollMinor'
    | 'netProfitMinor'
    | 'maxDrawdownFraction'
    | 'maxDrawdownMinor'
    | 'roundsReplayed'
    | 'stopReason'
  >,
  staking: StakingPlan | null = null,
): BlockBootstrapSummary {
  const { paths, seed, blockLength } = blockAnalysisSettingsSchema.parse(options);
  const n = sample.length;
  if (n > MAX_BACKTEST_ROUNDS) {
    throw new AnalysisLimitError(`The sample exceeds ${MAX_BACKTEST_ROUNDS} rounds.`);
  }
  // Sample size (≥ 20) and block length (2 … min(⌊n/10⌋, 500)); never coerced.
  const layout: MovingBlockLayout = movingBlockLayout(n, blockLength);
  if (paths * n > MAX_ANALYSIS_ROUND_STEPS) {
    throw new AnalysisLimitError(
      `${paths} paths of ${n} rounds is ${paths * n} replayed rounds; the limit is ${MAX_ANALYSIS_ROUND_STEPS}. Use at most ${maxPathsForSample(n)} paths for this sample.`,
    );
  }
  for (const m of sample) roundMultiplierX100Schema.parse(m);
  // Validates the strategy, settings and plan (against the strategy) and compiles the plan
  // once; each call of `replay` then starts a fresh replay.
  const replay = createSummaryReplayer(strategy, settings, staking);

  const stoppedByLimit: Record<LegKey, number> = { A: 0, B: 0 };
  const bankrollSkips: Record<LegKey, number> = { A: 0, B: 0 };
  const endings = new Float64Array(paths);
  const ddFraction = new Float64Array(paths);
  const ddMinor = new Float64Array(paths);
  const replayedCounts = new Float64Array(paths);
  const streaks = new Float64Array(paths);
  const stopReasons = Object.fromEntries(STOP_REASONS.map((r) => [r, 0])) as Record<
    StopReason,
    number
  >;
  let positive = 0;
  let zero = 0;
  let negative = 0;
  const buffer = new Int32Array(n);
  for (let p = 0; p < paths; p++) {
    const starts = drawBlockStarts(layout, blockPathGenerator(seed, p));
    const indices = blockPathIndices(layout, starts);
    for (let i = 0; i < n; i++) buffer[i] = sample[indices[i]!]!;
    const summary = replay(buffer);
    endings[p] = summary.endingBankrollMinor;
    ddFraction[p] = summary.maxDrawdownFraction;
    ddMinor[p] = summary.maxDrawdownMinor;
    replayedCounts[p] = summary.roundsReplayed;
    streaks[p] = summary.longestLosingStreak;
    stopReasons[summary.stopReason] += 1;
    for (const key of LEG_KEYS) {
      const leg = summary.progression?.legs[key];
      if (!leg) continue;
      if (leg.finalStatus !== 'active') stoppedByLimit[key] += 1;
      if (leg.skippedInsufficientBankroll > 0) bankrollSkips[key] += 1;
    }
    if (summary.netProfitMinor > 0) positive += 1;
    else if (summary.netProfitMinor < 0) negative += 1;
    else zero += 1;
  }

  const distinct = new Set(sample);
  const warnings: BlockBootstrapSummary['warnings'] = [];
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
  if (layout.candidateStarts < FEW_CANDIDATE_BLOCKS) {
    warnings.push({
      code: 'few_candidate_blocks',
      message: `Only ${layout.candidateStarts} distinct stretches of ${blockLength} rounds exist in this sample, so resampled paths reuse the same stretches heavily.`,
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
    algorithmVersion: MOVING_BLOCK_ALGORITHM_VERSION,
    seed,
    paths,
    sample: {
      size: n,
      distinctMultipliers: distinct.size,
      minMultiplierX100: sortedSample[0]!,
      maxMultiplierX100: sortedSample[sortedSample.length - 1]!,
    },
    pathLength: n,
    resampling: {
      method: 'moving_block',
      blockLength,
      blocksPerPath: layout.blocksPerPath,
      lastBlockLength: layout.lastBlockLength,
      candidateStarts: layout.candidateStarts,
    },
    stopReasons,
    endingBankrollMinor: distribution(endings),
    netOutcome: { positive, zero, negative, denominator: paths },
    maxDrawdownFraction: distribution(ddFraction),
    maxDrawdownMinor: distribution(ddMinor),
    roundsReplayed: distribution(replayedCounts),
    longestLosingStreak: distribution(streaks),
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
      netProfitMinor: observed.netProfitMinor,
      maxDrawdownFraction: observed.maxDrawdownFraction,
      maxDrawdownMinor: observed.maxDrawdownMinor,
      roundsReplayed: observed.roundsReplayed,
      stopReason: observed.stopReason,
      pathsEndingBelow: below,
      pathsEndingEqual: equal,
      pathsEndingAbove: paths - below - equal,
      denominator: paths,
    },
    warnings,
    ...(staking === null ? {} : { staking: stakingMetadata(staking) }),
  };

  function stakingMetadata(plan: StakingPlan): NonNullable<BlockBootstrapSummary['staking']> {
    const identity = stakingIdentity(plan);
    const leg = (key: LegKey) => {
      const id = identity[key];
      return id === null
        ? null
        : {
            ...id,
            pathsStoppedByLimit: stoppedByLimit[key],
            pathsWithBankrollSkips: bankrollSkips[key],
            denominator: paths,
          };
    };
    return { statePolicy: 'reset_each_path', legs: { A: leg('A'), B: leg('B') } };
  }
}
