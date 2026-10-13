import { z } from 'zod';
import {
  assertReplayableRounds,
  backtestSummarySchema,
  createSummaryReplayer,
  MAX_BACKTEST_ROUNDS,
  type BacktestRound,
  type BacktestSummary,
} from './backtest.js';
import type { TwoLegStrategyConfig } from './legs.js';
import { roundMultiplierX100Schema } from './multiplier.js';
import type { SimulationSettings } from './simulation.js';

/**
 * Chronological-block robustness (pass 6): does a configuration's historical result hold up
 * across separate periods of the same dataset, or does it depend on one stretch of it?
 *
 * VIRTUAL MONEY ONLY. Every figure is an in-sample replay of recorded rounds. Block results
 * are not predictions, not out-of-sample validation, and not evidence of future profit.
 *
 * Method (user-facing documentation follows with the API and UI increments):
 * - The caller supplies the dataset's eligible rounds in replay order (one source, strictly
 *   increasing event time), as for runBacktest, with every event time in canonical UTC form
 *   so that text order is chronological order. The order is never changed here.
 * - The rounds are split into W contiguous, non-overlapping blocks of nearly equal size,
 *   using only the round count and that order: never the multipliers or any outcome.
 * - The full sample and each block are replayed through the same replay loop as the
 *   historical backtest (createSummaryReplayer). Each block starts again from the configured
 *   starting bankroll with fresh state (peak, drawdown, streaks, stops, maxRounds); nothing
 *   carries over between blocks. Block results therefore do NOT add up to the full-sample
 *   result, which depends on the bankroll carried from one round to the next.
 */
export const ROBUSTNESS_ALGORITHM_VERSION = 'chronological-blocks/v1';

export const MIN_ROBUSTNESS_WINDOWS = 2;
export const MAX_ROBUSTNESS_WINDOWS = 10;
/** Every block must contain at least this many rounds. */
export const MIN_ROUNDS_PER_WINDOW = 30;
/**
 * Upper bound on replayed rounds per robustness experiment: configurations x (full sample +
 * all blocks) = configurations x 2 x sample size. With one configuration, the existing
 * per-backtest limit (MAX_BACKTEST_ROUNDS) is the tighter bound.
 */
export const MAX_ROBUSTNESS_ROUND_STEPS = 1_000_000;

/** Thrown before any replay when a request is malformed for, or too large for, this method. */
export class RobustnessLimitError extends RangeError {
  constructor(message: string) {
    super(message);
    this.name = 'RobustnessLimitError';
  }
}

export const robustnessOptionsSchema = z
  .object({
    windows: z.number().int().min(MIN_ROBUSTNESS_WINDOWS).max(MAX_ROBUSTNESS_WINDOWS),
  })
  .strict();
export type RobustnessOptions = z.infer<typeof robustnessOptionsSchema>;

const CANONICAL_UTC_INSTANT = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/;

/**
 * Event times must be real instants in the canonical UTC form the app writes
 * (Date#toISOString). Only then does the text order checked by assertReplayableRounds equal
 * chronological order: '2026-01-01T00:00:30+01:00' sorts after '2026-01-01T00:00:29.000Z' as
 * text but is an hour earlier. Throws RangeError.
 */
function assertCanonicalEventTimes(sample: readonly BacktestRound[]): void {
  for (const round of sample) {
    const text = round.eventAt;
    const instant = typeof text === 'string' ? Date.parse(text) : Number.NaN;
    if (
      !CANONICAL_UTC_INSTANT.test(text) ||
      Number.isNaN(instant) ||
      new Date(instant).toISOString() !== text
    ) {
      throw new RangeError(
        `Round ${round.roundId} has an event time that is not a real instant in canonical UTC form (YYYY-MM-DDTHH:MM:SS.sssZ), so chronological order cannot be guaranteed`,
      );
    }
  }
}

function assertCount(value: number, what: string, min: number): void {
  if (!Number.isSafeInteger(value) || value < min) {
    throw new RobustnessLimitError(`${what} must be an integer of at least ${min}`);
  }
}

/** The most blocks a sample of this size allows (0 if it is too small for any). */
export function maxWindowsForSample(sampleSize: number): number {
  assertCount(sampleSize, 'The sample size', 0);
  const most = Math.min(MAX_ROBUSTNESS_WINDOWS, Math.floor(sampleSize / MIN_ROUNDS_PER_WINDOW));
  return most < MIN_ROBUSTNESS_WINDOWS ? 0 : most;
}

/**
 * Replayed rounds for `configurations` configurations over a sample (full sample plus every
 * block, which together cover the sample once more). Throws before any multiplication could
 * exceed the safe integer range, and when the total exceeds MAX_ROBUSTNESS_ROUND_STEPS.
 */
export function assertRobustnessWorkload(sampleSize: number, configurations: number): number {
  assertCount(sampleSize, 'The sample size', 1);
  assertCount(configurations, 'The number of configurations', 1);
  const perConfiguration = 2 * sampleSize;
  if (perConfiguration > Math.floor(MAX_ROBUSTNESS_ROUND_STEPS / configurations)) {
    throw new RobustnessLimitError(
      `${configurations} configuration(s) over ${sampleSize} rounds (full sample plus blocks) exceeds the limit of ${MAX_ROBUSTNESS_ROUND_STEPS} replayed rounds.`,
    );
  }
  return configurations * perConfiguration;
}

export interface ChronologicalBlock {
  /** 0-based block number, in chronological order. */
  index: number;
  /** First round of the block, as an index into the replay order (inclusive). */
  startIndex: number;
  /** End of the block (exclusive): the block is [startIndex, endIndex). */
  endIndex: number;
  roundCount: number;
}

/**
 * Splits `roundCount` rounds (already in replay order) into `windowCount` contiguous,
 * non-overlapping, half-open blocks [startIndex, endIndex) that cover every index exactly
 * once. Sizes differ by at most one; the first roundCount % windowCount blocks get the extra
 * round. Depends only on the counts. Throws RobustnessLimitError for malformed counts or when
 * a block would have fewer than `minRoundsPerBlock` rounds (nothing is truncated). The
 * minimum defaults to MIN_ROUNDS_PER_WINDOW, which runBlockRobustness always uses.
 */
export function partitionChronological(
  roundCount: number,
  windowCount: number,
  minRoundsPerBlock: number = MIN_ROUNDS_PER_WINDOW,
): ChronologicalBlock[] {
  assertCount(roundCount, 'The number of rounds', 0);
  assertCount(minRoundsPerBlock, 'The minimum block size', 1);
  if (
    !Number.isSafeInteger(windowCount) ||
    windowCount < MIN_ROBUSTNESS_WINDOWS ||
    windowCount > MAX_ROBUSTNESS_WINDOWS
  ) {
    throw new RobustnessLimitError(
      `The number of blocks must be an integer from ${MIN_ROBUSTNESS_WINDOWS} to ${MAX_ROBUSTNESS_WINDOWS}`,
    );
  }
  const base = Math.floor(roundCount / windowCount);
  if (base < minRoundsPerBlock) {
    throw new RobustnessLimitError(
      `${roundCount} rounds cannot form ${windowCount} blocks of at least ${minRoundsPerBlock} rounds; at least ${windowCount * minRoundsPerBlock} are needed.`,
    );
  }
  const extra = roundCount % windowCount;
  const blocks: ChronologicalBlock[] = [];
  let start = 0;
  for (let index = 0; index < windowCount; index++) {
    const size = base + (index < extra ? 1 : 0);
    blocks.push({ index, startIndex: start, endIndex: start + size, roundCount: size });
    start += size;
  }
  return blocks;
}

export interface BlockReplayResult extends ChronologicalBlock {
  firstRoundId: number;
  lastRoundId: number;
  /** Stored event times of the block's first and last rounds (never invented). */
  firstEventAt: string;
  lastEventAt: string;
  /** An independent replay of this block only, from the starting bankroll. */
  summary: BacktestSummary;
}

export interface BlockRobustnessResult {
  algorithmVersion: string;
  windows: number;
  sampleSize: number;
  /** Rounds that could be replayed in total: full sample plus every block. */
  roundStepsBudgeted: number;
  /** The whole sample replayed once, as the historical backtest does. */
  full: {
    firstEventAt: string;
    lastEventAt: string;
    summary: BacktestSummary;
  };
  /** Independent replays, in chronological order. Not to be summed into a full result. */
  blocks: BlockReplayResult[];
}

/**
 * Replays the full sample and each chronological block with one configuration. Validates
 * everything (options, size and workload limits, round order and multipliers, strategy and
 * settings) before replaying anything. Throws RobustnessLimitError for limits and malformed
 * counts, ZodError for invalid options or configuration, RangeError for unordered or invalid
 * rounds (including event times not in canonical UTC form), and BacktestLimitError if exact
 * results would leave the safe integer range.
 */
export function runBlockRobustness(
  sample: readonly BacktestRound[],
  strategy: TwoLegStrategyConfig,
  settings: SimulationSettings,
  options: RobustnessOptions,
): BlockRobustnessResult {
  const { windows } = robustnessOptionsSchema.parse(options);
  const n = sample.length;
  if (n > MAX_BACKTEST_ROUNDS) {
    throw new RobustnessLimitError(
      `The sample has ${n} rounds; a backtest replays at most ${MAX_BACKTEST_ROUNDS}.`,
    );
  }
  const plan = partitionChronological(n, windows);
  const roundStepsBudgeted = assertRobustnessWorkload(n, 1);
  assertReplayableRounds(sample);
  assertCanonicalEventTimes(sample);
  const multipliers = new Int32Array(n);
  for (let i = 0; i < n; i++) {
    multipliers[i] = roundMultiplierX100Schema.parse(sample[i]!.multiplierX100);
  }
  const replay = createSummaryReplayer(strategy, settings);

  const full = replay(multipliers);
  const blocks = plan.map((block): BlockReplayResult => {
    const summary = replay(multipliers.subarray(block.startIndex, block.endIndex));
    if (
      summary.roundsAvailable !== block.roundCount ||
      summary.startingBankrollMinor !== settings.startingBankrollMinor
    ) {
      throw new Error('Invariant violated: a block was not replayed independently');
    }
    const first = sample[block.startIndex]!;
    const last = sample[block.endIndex - 1]!;
    return {
      ...block,
      firstRoundId: first.roundId,
      lastRoundId: last.roundId,
      firstEventAt: first.eventAt,
      lastEventAt: last.eventAt,
      summary,
    };
  });
  return {
    algorithmVersion: ROBUSTNESS_ALGORITHM_VERSION,
    windows,
    sampleSize: n,
    roundStepsBudgeted,
    full: { firstEventAt: sample[0]!.eventAt, lastEventAt: sample[n - 1]!.eventAt, summary: full },
    blocks,
  };
}

const chronologicalBlockSchema = z.object({
  index: z.number().int().min(0),
  startIndex: z.number().int().min(0),
  endIndex: z.number().int().min(1),
  roundCount: z.number().int().min(MIN_ROUNDS_PER_WINDOW),
});

/** JSON shape of a BlockRobustnessResult, for storage and API contracts. */
export const blockRobustnessResultSchema = z.object({
  algorithmVersion: z.string(),
  windows: z.number().int().min(MIN_ROBUSTNESS_WINDOWS).max(MAX_ROBUSTNESS_WINDOWS),
  sampleSize: z.number().int().min(1),
  roundStepsBudgeted: z.number().int().min(1),
  full: z.object({
    firstEventAt: z.string(),
    lastEventAt: z.string(),
    summary: backtestSummarySchema,
  }),
  blocks: z.array(
    chronologicalBlockSchema.extend({
      firstRoundId: z.number().int(),
      lastRoundId: z.number().int(),
      firstEventAt: z.string(),
      lastEventAt: z.string(),
      summary: backtestSummarySchema,
    }),
  ),
});
