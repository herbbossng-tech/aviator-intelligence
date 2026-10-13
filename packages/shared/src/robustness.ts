import { z } from 'zod';
import {
  assertReplayableRounds,
  backtestSummarySchema,
  createSummaryReplayer,
  MAX_BACKTEST_ROUNDS,
  type BacktestRound,
  type BacktestSummary,
} from './backtest.js';
import { LEG_KEYS, type LegKey, type TwoLegStrategyConfig } from './legs.js';
import { roundMultiplierX100Schema } from './multiplier.js';
import type { SimulationSettings } from './simulation.js';
import {
  legStakingIdentitySchema,
  stakingIdentity,
  type LegStakingIdentity,
  type StakingPlan,
} from './staking.js';

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
 *   starting bankroll with fresh state (peak, drawdown, streaks, stops, maxRounds and, for a
 *   leg with a staking progression, the progression's first step with no cycle loss);
 *   nothing carries over between blocks. Block results therefore do NOT add up to the full-sample
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
  /**
   * Only for a run with a staking plan: which progressions were replayed, and that the full
   * sample and every block started them afresh. Absent for flat-stake runs.
   */
  staking?:
    | {
        statePolicy: 'reset_each_block';
        legs: Record<LegKey, LegStakingIdentity | null>;
      }
    | undefined;
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
  staking: StakingPlan | null = null,
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
  const replay = createSummaryReplayer(strategy, settings, staking);

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
    ...(staking === null
      ? {}
      : { staking: { statePolicy: 'reset_each_block' as const, legs: stakingIdentity(staking) } }),
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
  /**
   * Present only when the run used a staking plan: which progressions were replayed, and
   * that each replay (the full sample and every block) started them afresh.
   */
  staking: z
    .object({
      statePolicy: z.literal('reset_each_block'),
      legs: z
        .object({ A: legStakingIdentitySchema.nullable(), B: legStakingIdentitySchema.nullable() })
        .strict(),
    })
    .strict()
    .optional(),
});

// ---------------------------------------------------------------------------
// Stored results: versions and strict verification
// ---------------------------------------------------------------------------

/** Algorithm versions this build can interpret. */
export const SUPPORTED_ROBUSTNESS_ALGORITHM_VERSIONS: readonly string[] = [
  ROBUSTNESS_ALGORITHM_VERSION,
];
/** Version of the stored result format (the JSON written by persistence). */
export const ROBUSTNESS_RESULT_SCHEMA_VERSION = 1;
export const SUPPORTED_ROBUSTNESS_RESULT_SCHEMA_VERSIONS: readonly number[] = [
  ROBUSTNESS_RESULT_SCHEMA_VERSION,
];

/** A result failed verification: corrupted, inconsistent, unsupported or mismatched. */
export class RobustnessResultError extends Error {
  constructor(readonly issues: readonly string[]) {
    super(`Robustness result failed verification: ${issues.slice(0, 5).join('; ')}`);
    this.name = 'RobustnessResultError';
  }
}

/** What a result must agree with. Everything here comes from trusted server-side sources. */
export interface RobustnessExpectations {
  windows: number;
  sampleSize: number;
  strategy: TwoLegStrategyConfig;
  settings: SimulationSettings;
  /** The run's stored summary over the same dataset; the full-sample replay must equal it. */
  observedSummary?: BacktestSummary;
  /** The source rounds in replay order, when available (block ids and times must match). */
  rounds?: readonly Pick<BacktestRound, 'roundId' | 'eventAt'>[];
  /** The run's staking plan; omitted or null for a flat-stake run. */
  staking?: StakingPlan | null;
}

function isCanonicalInstant(text: unknown): boolean {
  if (typeof text !== 'string' || !CANONICAL_UTC_INSTANT.test(text)) return false;
  const instant = Date.parse(text);
  return !Number.isNaN(instant) && new Date(instant).toISOString() === text;
}

/** Structural equality of JSON-compatible values, ignoring object key order. */
function sameJson(a: unknown, b: unknown): boolean {
  if (a === b) return true;
  if (typeof a !== 'object' || typeof b !== 'object' || a === null || b === null) return false;
  if (Array.isArray(a) !== Array.isArray(b)) return false;
  const ka = Object.keys(a);
  const kb = Object.keys(b);
  if (ka.length !== kb.length) return false;
  return ka.every(
    (k) =>
      Object.prototype.hasOwnProperty.call(b, k) &&
      sameJson((a as Record<string, unknown>)[k], (b as Record<string, unknown>)[k]),
  );
}

function checkSummary(
  issues: string[],
  where: string,
  s: BacktestSummary,
  roundCount: number,
  {
    strategy,
    settings,
    staking,
  }: Pick<RobustnessExpectations, 'strategy' | 'settings' | 'staking'>,
): void {
  const fail = (message: string) => issues.push(`${where}: ${message}`);
  if (s.currency !== settings.currency) fail('currency differs from the settings');
  if (s.startingBankrollMinor !== settings.startingBankrollMinor) {
    fail('did not start from the configured bankroll');
  }
  if (s.roundsAvailable !== roundCount) fail(`roundsAvailable is not ${roundCount}`);
  if (s.roundsReplayed < 0 || s.roundsReplayed + s.roundsNotReplayed !== s.roundsAvailable) {
    fail('replayed and not-replayed rounds do not add up to the rounds available');
  }
  if (settings.risk.maxRounds !== null && s.roundsReplayed > settings.risk.maxRounds) {
    fail('replayed more rounds than maxRounds allows');
  }
  if (s.endingBankrollMinor < 0) fail('ending bankroll is negative');
  if (s.endingBankrollMinor !== s.startingBankrollMinor + s.netProfitMinor) {
    fail('ending bankroll != starting bankroll + net');
  }
  if (s.netProfitMinor !== s.totalReturnedMinor - s.totalStakedMinor) {
    fail('net != returned - staked');
  }
  if (s.roundsWithProfit + s.roundsWithLoss + s.roundsBreakEven !== s.roundsReplayed) {
    fail('profit, loss and break-even rounds do not add up to the rounds replayed');
  }
  if (
    s.lowestBankrollMinor > s.endingBankrollMinor ||
    s.peakBankrollMinor < s.endingBankrollMinor ||
    s.peakBankrollMinor < s.startingBankrollMinor ||
    s.maxDrawdownMinor > s.peakBankrollMinor - s.lowestBankrollMinor
  ) {
    fail('peak, lowest, ending bankroll and drawdown are inconsistent');
  }
  const keys = s.legs.map((l) => l.leg).join(',');
  if (keys !== 'A,B') {
    fail('legs must be A then B');
    return;
  }
  let staked = 0;
  let returned = 0;
  for (const leg of s.legs) {
    const configured = strategy.legs[leg.leg];
    if (
      leg.label !== configured.label ||
      leg.enabled !== configured.enabled ||
      leg.stakeMinor !== configured.stakeMinor ||
      leg.cashoutTargetX100 !== configured.cashoutTargetX100
    ) {
      fail(`leg ${leg.leg} does not match the strategy`);
    }
    if (leg.wins + leg.losses !== leg.placed) fail(`leg ${leg.leg}: wins + losses != placed`);
    if (leg.netMinor !== leg.grossReturnMinor - leg.stakedMinor) {
      fail(`leg ${leg.leg}: net != returned - staked`);
    }
    if (!leg.enabled && (leg.placed !== 0 || leg.skipped !== 0)) {
      fail(`leg ${leg.leg} is disabled but has entries`);
    }
    staked += leg.stakedMinor;
    returned += leg.grossReturnMinor;
  }
  if (staked !== s.totalStakedMinor || returned !== s.totalReturnedMinor) {
    fail('leg totals do not add up to the summary totals');
  }
  // Progressions: present exactly for the plan's legs, with the plan's identity, and every
  // skip and completed cycle reconciled with the leg's own totals.
  const plan = staking ?? null;
  if ((s.progression === undefined) !== (plan === null)) {
    fail('the progression summary does not match the staking plan');
    return;
  }
  if (s.progression === undefined || plan === null) return;
  const identity = stakingIdentity(plan);
  for (const key of LEG_KEYS) {
    const p = s.progression.legs[key];
    const id = identity[key];
    if (p === null || id === null) {
      if (p !== null || id !== null) fail(`leg ${key}'s progression does not match the plan`);
      continue;
    }
    if (p.mode !== id.mode || p.configKey !== id.configKey) {
      fail(`leg ${key}'s progression does not match the plan`);
    }
    const leg = s.legs.find((l) => l.leg === key)!;
    if (p.skippedInsufficientBankroll + p.skippedInactive !== leg.skipped) {
      fail(`leg ${key}: progression skips do not add up to the leg's skips`);
    }
    if (p.cyclesCompleted !== leg.wins) fail(`leg ${key}: completed cycles != wins`);
  }
}

/**
 * Verifies a robustness result against what it must agree with, beyond basic types:
 * supported version; declared windows, sample size and workload; one block per window, with
 * indices, boundaries and sizes exactly equal to partitionChronological (so blocks are
 * contiguous, non-overlapping and cover the sample once); canonical, chronological event
 * times consistent across blocks and the full sample; every summary reconciled exactly and
 * matching the strategy and settings; and, when supplied, the run's stored summary and the
 * source rounds. Throws RobustnessResultError listing every problem; never repairs anything.
 */
export function verifyBlockRobustnessResult(
  value: unknown,
  expected: RobustnessExpectations,
): BlockRobustnessResult {
  const parsed = blockRobustnessResultSchema.safeParse(value);
  if (!parsed.success) {
    throw new RobustnessResultError(
      parsed.error.issues.slice(0, 20).map((i) => `${i.path.join('.') || 'result'}: ${i.message}`),
    );
  }
  const result = parsed.data;
  const issues: string[] = [];
  if (!SUPPORTED_ROBUSTNESS_ALGORITHM_VERSIONS.includes(result.algorithmVersion)) {
    issues.push(`unsupported algorithm version ${JSON.stringify(result.algorithmVersion)}`);
  }
  if (result.windows !== expected.windows) {
    issues.push(`declares ${result.windows} windows; ${expected.windows} were requested`);
  }
  if (result.sampleSize !== expected.sampleSize) {
    issues.push(`declares ${result.sampleSize} rounds; the sample has ${expected.sampleSize}`);
  }
  if (result.blocks.length !== result.windows) {
    issues.push(`has ${result.blocks.length} blocks for ${result.windows} windows`);
  }
  if (result.roundStepsBudgeted !== 2 * result.sampleSize) {
    issues.push('roundStepsBudgeted is not twice the sample size');
  }

  // Boundaries: explicit gap/overlap messages, then exact agreement with the partition.
  let expectedStart = 0;
  for (const [i, b] of result.blocks.entries()) {
    if (b.index !== i) issues.push(`block ${i} has index ${b.index}`);
    if (b.startIndex > expectedStart) issues.push(`gap before block ${i}`);
    if (b.startIndex < expectedStart) issues.push(`block ${i} overlaps the previous block`);
    if (b.endIndex - b.startIndex !== b.roundCount || b.endIndex <= b.startIndex) {
      issues.push(`block ${i} boundaries do not match its round count`);
    }
    expectedStart = b.endIndex;
  }
  if (result.blocks.length > 0 && expectedStart !== result.sampleSize) {
    issues.push(
      `blocks end at index ${expectedStart}, not at the sample size ${result.sampleSize}`,
    );
  }
  try {
    const plan = partitionChronological(result.sampleSize, result.windows);
    if (
      plan.length !== result.blocks.length ||
      plan.some(
        (p, i) =>
          p.startIndex !== result.blocks[i]!.startIndex ||
          p.endIndex !== result.blocks[i]!.endIndex ||
          p.roundCount !== result.blocks[i]!.roundCount,
      )
    ) {
      issues.push('blocks differ from the chronological partition of the sample');
    }
  } catch (error) {
    issues.push(`the declared sample cannot be partitioned: ${(error as Error).message}`);
  }

  // Event times: canonical, chronological, consistent between the blocks and the full sample.
  const times = [
    result.full.firstEventAt,
    result.full.lastEventAt,
    ...result.blocks.flatMap((b) => [b.firstEventAt, b.lastEventAt]),
  ];
  if (!times.every(isCanonicalInstant)) issues.push('an event time is not canonical UTC');
  const first = result.blocks[0];
  const last = result.blocks.at(-1);
  if (first && first.firstEventAt !== result.full.firstEventAt) {
    issues.push('the first block does not start at the sample start');
  }
  if (last && last.lastEventAt !== result.full.lastEventAt) {
    issues.push('the last block does not end at the sample end');
  }
  for (const [i, b] of result.blocks.entries()) {
    if (!(b.firstEventAt < b.lastEventAt)) issues.push(`block ${i} times are not increasing`);
    const next = result.blocks[i + 1];
    if (next && !(b.lastEventAt < next.firstEventAt)) {
      issues.push(`block ${i + 1} does not start after block ${i} ends`);
    }
    if (b.firstRoundId < 1 || b.lastRoundId < 1) issues.push(`block ${i} has an invalid round id`);
  }

  // Source rounds, when available: ids and times at every boundary must match exactly.
  if (expected.rounds) {
    const rounds = expected.rounds;
    if (rounds.length !== result.sampleSize) {
      issues.push(`the source has ${rounds.length} rounds, not ${result.sampleSize}`);
    } else {
      for (const [i, b] of result.blocks.entries()) {
        const firstRound = rounds[b.startIndex];
        const lastRound = rounds[b.endIndex - 1];
        if (
          !firstRound ||
          !lastRound ||
          firstRound.roundId !== b.firstRoundId ||
          lastRound.roundId !== b.lastRoundId ||
          firstRound.eventAt !== b.firstEventAt ||
          lastRound.eventAt !== b.lastEventAt
        ) {
          issues.push(`block ${i} round ids or times do not match the source rounds`);
        }
      }
    }
  }

  checkSummary(issues, 'full sample', result.full.summary, result.sampleSize, expected);
  for (const [i, b] of result.blocks.entries()) {
    checkSummary(issues, `block ${i}`, b.summary, b.roundCount, expected);
  }
  const plan = expected.staking ?? null;
  if ((result.staking === undefined) !== (plan === null)) {
    issues.push('the staking metadata does not match the staking plan');
  } else if (result.staking !== undefined && plan !== null) {
    if (!sameJson(result.staking.legs, stakingIdentity(plan))) {
      issues.push("the staking metadata does not identify the plan's progressions");
    }
  }
  if (expected.observedSummary && !sameJson(result.full.summary, expected.observedSummary)) {
    issues.push("the full-sample replay differs from the run's stored result");
  }

  if (issues.length > 0) throw new RobustnessResultError(issues);
  return result;
}

// ---------------------------------------------------------------------------
// API contracts
// ---------------------------------------------------------------------------

/** POST /api/simulations/:id/robustness */
export const robustnessRequestSchema = robustnessOptionsSchema;

export const robustnessAnalysesQuerySchema = z
  .object({
    limit: z.coerce.number().int().min(1).max(50).default(20),
    offset: z.coerce.number().int().min(0).max(10_000_000).default(0),
    /** Only analyses with this many blocks. */
    windows: z.coerce
      .number()
      .int()
      .min(MIN_ROBUSTNESS_WINDOWS)
      .max(MAX_ROBUSTNESS_WINDOWS)
      .optional(),
  })
  .strict();
export type RobustnessAnalysesQuery = z.infer<typeof robustnessAnalysesQuerySchema>;

export const robustnessAnalysisDtoSchema = z.object({
  id: z.number().int(),
  simulationRunId: z.number().int(),
  status: z.literal('completed'),
  createdAt: z.string(),
  completedAt: z.string(),
  algorithmVersion: z.string(),
  resultSchemaVersion: z.number().int(),
  windows: z.number().int(),
  sampleSize: z.number().int(),
  datasetSha256: z.string(),
  result: blockRobustnessResultSchema,
});
export type RobustnessAnalysisDto = z.infer<typeof robustnessAnalysisDtoSchema>;

export const robustnessAnalysesListSchema = z.object({
  items: z.array(robustnessAnalysisDtoSchema),
  total: z.number().int(),
  limit: z.number().int(),
  offset: z.number().int(),
  /** Largest block count this run's sample allows (0: too few rounds for any). */
  maxWindows: z.number().int(),
  sampleSize: z.number().int().nullable(),
});
export type RobustnessAnalysesList = z.infer<typeof robustnessAnalysesListSchema>;
