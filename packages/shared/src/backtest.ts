import { z } from 'zod';
import {
  LEG_KEYS,
  twoLegStrategyConfigSchema,
  type LegKey,
  type TwoLegStrategyConfig,
} from './legs.js';
import { currencyCodeSchema } from './money.js';
import { MAX_SOURCE_LENGTH, parseIsoDateTimeWithOffset } from './rounds.js';
import { settleLeg, simulationSettingsSchema, type SimulationSettings } from './simulation.js';

/**
 * Deterministic virtual backtest of a two-leg strategy over historical rounds.
 *
 * VIRTUAL MONEY ONLY. A backtest replays recorded rounds; it is not evidence that a
 * configuration will be profitable on future rounds, which are independent of the past.
 *
 * Replay model (see docs/SIMULATION.md):
 * - Input rounds must already be in replay order: one source, strictly increasing eventAt.
 * - Each round, every ENABLED leg is staked from the bankroll available at the start of the
 *   round (A first, then B). Disabled legs produce no ledger entry.
 * - Each placed leg is settled with settleLeg(): it reaches its target when the round's
 *   crash multiplier M >= target T, returning floor(stake * T / 100) minor units (gross,
 *   INCLUDING the returned stake); otherwise the stake is lost. Net = gross - stake.
 * - Bankroll after the round = bankroll before + sum of leg nets. No leg's stake can exceed
 *   the funds available, so the bankroll never goes negative.
 * - Only the configuration and the bankroll so far drive decisions; a round's own multiplier
 *   is used only to settle that round (no look-ahead).
 */

/** Largest selection a single backtest replays (keeps the ledger write bounded). */
export const MAX_BACKTEST_ROUNDS = 100_000;

export interface BacktestRound {
  roundId: number;
  multiplierX100: number;
  /** Normalised UTC ISO-8601 event time; strictly increasing across the input. */
  eventAt: string;
}

export const STOP_REASONS = [
  'completed_all_rounds',
  'bankroll_exhausted',
  'insufficient_bankroll',
  'stop_below',
  'stop_at_or_above',
  'max_drawdown',
  'max_rounds',
] as const;
export type StopReason = (typeof STOP_REASONS)[number];

export const STOP_REASON_TEXT: Record<StopReason, string> = {
  completed_all_rounds: 'Every eligible round was replayed.',
  bankroll_exhausted: 'The virtual bankroll could no longer cover the smallest enabled stake.',
  insufficient_bankroll:
    'The virtual bankroll could not cover all enabled stakes (policy: stop the run).',
  stop_below: 'The virtual bankroll fell below the configured lower stop.',
  stop_at_or_above: 'The virtual bankroll reached the configured upper stop.',
  max_drawdown: 'The drawdown from the peak bankroll reached the configured limit.',
  max_rounds: 'The configured maximum number of rounds was reached.',
};

export interface BacktestLegEntry {
  leg: LegKey;
  result: 'win' | 'loss' | 'skipped';
  stakeMinor: number;
  cashoutTargetX100: number;
  /** Total paid back on a successful cashout, including the returned stake. 0 otherwise. */
  grossReturnMinor: number;
  /** grossReturnMinor - stakeMinor. */
  netMinor: number;
}

export interface BacktestRoundResult {
  sequenceNo: number;
  roundId: number;
  eventAt: string;
  multiplierX100: number;
  bankrollBeforeMinor: number;
  bankrollAfterMinor: number;
  roundNetMinor: number;
  legs: BacktestLegEntry[];
}

export interface LegSummary {
  leg: LegKey;
  label: string;
  enabled: boolean;
  stakeMinor: number;
  cashoutTargetX100: number;
  placed: number;
  wins: number;
  losses: number;
  skipped: number;
  stakedMinor: number;
  grossReturnMinor: number;
  netMinor: number;
  /** wins / placed: the share of placed bets whose target was reached, or null if none placed. */
  targetReachedShare: number | null;
}

export interface BacktestSummary {
  currency: TwoLegStrategyConfig['currency'];
  roundsAvailable: number;
  roundsReplayed: number;
  roundsNotReplayed: number;
  stopReason: StopReason;
  startingBankrollMinor: number;
  endingBankrollMinor: number;
  totalStakedMinor: number;
  /** Gross: total paid back on successful cashouts, including returned stakes. */
  totalReturnedMinor: number;
  /** endingBankroll - startingBankroll (= totalReturned - totalStaked). */
  netProfitMinor: number;
  /** netProfit / startingBankroll (e.g. -0.25 = lost a quarter of the starting bankroll). */
  returnOnStartingBankroll: number;
  roundsWithProfit: number;
  roundsWithLoss: number;
  roundsBreakEven: number;
  /** roundsWithProfit / roundsReplayed, or null when nothing was replayed. */
  profitableRoundShare: number | null;
  peakBankrollMinor: number;
  lowestBankrollMinor: number;
  /** Largest fall from a running peak to a later bankroll, in minor units. */
  maxDrawdownMinor: number;
  /** That fall as a fraction of the peak it was measured from (0..1). */
  maxDrawdownFraction: number;
  longestLosingStreak: number;
  legs: LegSummary[];
}

export interface BacktestResult {
  rounds: BacktestRoundResult[];
  summary: BacktestSummary;
}

function legOrder(strategy: TwoLegStrategyConfig) {
  return LEG_KEYS.map((key) => ({ key, ...strategy.legs[key] }));
}

/** Validates inputs that the schemas cannot check on their own. Throws RangeError. */
function assertReplayableRounds(rounds: readonly BacktestRound[]): void {
  if (rounds.length > MAX_BACKTEST_ROUNDS) {
    throw new RangeError(`A backtest replays at most ${MAX_BACKTEST_ROUNDS} rounds`);
  }
  const ids = new Set<number>();
  let previous = '';
  for (const r of rounds) {
    if (!Number.isSafeInteger(r.roundId) || r.roundId < 1 || ids.has(r.roundId)) {
      throw new RangeError(`Invalid or repeated round id ${r.roundId}`);
    }
    ids.add(r.roundId);
    if (typeof parseIsoDateTimeWithOffset(r.eventAt) !== 'number' || r.eventAt <= previous) {
      throw new RangeError('Rounds must have valid event times in strictly increasing order');
    }
    previous = r.eventAt;
  }
}

function exceedsDrawdown(peak: number, bankroll: number, maxDrawdownBps: number): boolean {
  // (peak - bankroll) / peak >= bps / 10000, in exact BigInt arithmetic.
  return BigInt(peak - bankroll) * 10_000n >= BigInt(maxDrawdownBps) * BigInt(peak);
}

export function runBacktest(
  rounds: readonly BacktestRound[],
  strategyInput: TwoLegStrategyConfig,
  settingsInput: SimulationSettings,
): BacktestResult {
  const strategy = twoLegStrategyConfigSchema.parse(strategyInput);
  const settings = simulationSettingsSchema.parse(settingsInput);
  if (strategy.currency !== settings.currency) {
    throw new RangeError('Strategy and settings must use the same currency');
  }
  assertReplayableRounds(rounds);

  const legs = legOrder(strategy);
  const enabled = legs.filter((l) => l.enabled);
  const minStake = Math.min(...enabled.map((l) => l.stakeMinor));
  const totalStake = enabled.reduce((s, l) => s + l.stakeMinor, 0);
  const { risk } = settings;

  const legTotals = new Map(
    legs.map((l) => [
      l.key,
      {
        placed: 0,
        wins: 0,
        losses: 0,
        skipped: 0,
        stakedMinor: 0,
        grossReturnMinor: 0,
        netMinor: 0,
      },
    ]),
  );
  const results: BacktestRoundResult[] = [];
  let bankroll = settings.startingBankrollMinor;
  let peak = bankroll;
  let lowest = bankroll;
  let maxDrawdownMinor = 0;
  let maxDrawdownFraction = 0;
  let streak = 0;
  let longestLosingStreak = 0;
  let profit = 0;
  let loss = 0;
  let breakEven = 0;
  let stopReason: StopReason = 'completed_all_rounds';

  for (const [index, round] of rounds.entries()) {
    // Pre-round stops depend only on the configuration and the bankroll so far.
    if (risk.maxRounds !== null && index >= risk.maxRounds) {
      stopReason = 'max_rounds';
      break;
    }
    if (bankroll < minStake) {
      stopReason = 'bankroll_exhausted';
      break;
    }
    if (settings.insufficientBankrollPolicy === 'stop_run' && bankroll < totalStake) {
      stopReason = 'insufficient_bankroll';
      break;
    }

    let available = bankroll;
    const entries: BacktestLegEntry[] = [];
    for (const leg of enabled) {
      const totals = legTotals.get(leg.key)!;
      if (leg.stakeMinor > available) {
        // Only reachable under 'skip_leg': this leg cannot be funded this round.
        entries.push({
          leg: leg.key,
          result: 'skipped',
          stakeMinor: 0,
          cashoutTargetX100: leg.cashoutTargetX100,
          grossReturnMinor: 0,
          netMinor: 0,
        });
        totals.skipped += 1;
        continue;
      }
      available -= leg.stakeMinor;
      const settled = settleLeg(leg, round.multiplierX100);
      entries.push({
        leg: leg.key,
        result: settled.result,
        stakeMinor: leg.stakeMinor,
        cashoutTargetX100: leg.cashoutTargetX100,
        grossReturnMinor: settled.grossReturnMinor,
        netMinor: settled.netMinor,
      });
      totals.placed += 1;
      totals.stakedMinor += leg.stakeMinor;
      totals.grossReturnMinor += settled.grossReturnMinor;
      totals.netMinor += settled.netMinor;
      if (settled.result === 'win') totals.wins += 1;
      else totals.losses += 1;
    }

    const roundNetMinor = entries.reduce((s, e) => s + e.netMinor, 0);
    const after = bankroll + roundNetMinor;
    if (!Number.isSafeInteger(after) || after < 0) {
      throw new RangeError('Bankroll left the supported integer range');
    }
    results.push({
      sequenceNo: index,
      roundId: round.roundId,
      eventAt: round.eventAt,
      multiplierX100: round.multiplierX100,
      bankrollBeforeMinor: bankroll,
      bankrollAfterMinor: after,
      roundNetMinor,
      legs: entries,
    });
    bankroll = after;

    if (roundNetMinor > 0) profit += 1;
    else if (roundNetMinor < 0) loss += 1;
    else breakEven += 1;
    streak = roundNetMinor < 0 ? streak + 1 : 0;
    longestLosingStreak = Math.max(longestLosingStreak, streak);
    peak = Math.max(peak, bankroll);
    lowest = Math.min(lowest, bankroll);
    if (peak - bankroll > maxDrawdownMinor) {
      maxDrawdownMinor = peak - bankroll;
      maxDrawdownFraction = maxDrawdownMinor / peak;
    }

    // Post-round stops take effect before the next round.
    if (risk.stopBelowBankrollMinor !== null && bankroll < risk.stopBelowBankrollMinor) {
      stopReason = 'stop_below';
      break;
    }
    if (risk.stopAtOrAboveBankrollMinor !== null && bankroll >= risk.stopAtOrAboveBankrollMinor) {
      stopReason = 'stop_at_or_above';
      break;
    }
    if (
      risk.maxDrawdownBps !== null &&
      peak > 0 &&
      exceedsDrawdown(peak, bankroll, risk.maxDrawdownBps)
    ) {
      stopReason = 'max_drawdown';
      break;
    }
  }

  const legSummaries: LegSummary[] = legs.map((l) => {
    const t = legTotals.get(l.key)!;
    return {
      leg: l.key,
      label: l.label,
      enabled: l.enabled,
      stakeMinor: l.stakeMinor,
      cashoutTargetX100: l.cashoutTargetX100,
      ...t,
      targetReachedShare: t.placed === 0 ? null : t.wins / t.placed,
    };
  });
  const totalStakedMinor = legSummaries.reduce((s, l) => s + l.stakedMinor, 0);
  const totalReturnedMinor = legSummaries.reduce((s, l) => s + l.grossReturnMinor, 0);
  const netProfitMinor = bankroll - settings.startingBankrollMinor;
  if (netProfitMinor !== totalReturnedMinor - totalStakedMinor) {
    throw new Error('Ledger does not reconcile: net profit != returned - staked');
  }
  return {
    rounds: results,
    summary: {
      currency: strategy.currency,
      roundsAvailable: rounds.length,
      roundsReplayed: results.length,
      roundsNotReplayed: rounds.length - results.length,
      stopReason,
      startingBankrollMinor: settings.startingBankrollMinor,
      endingBankrollMinor: bankroll,
      totalStakedMinor,
      totalReturnedMinor,
      netProfitMinor,
      returnOnStartingBankroll: netProfitMinor / settings.startingBankrollMinor,
      roundsWithProfit: profit,
      roundsWithLoss: loss,
      roundsBreakEven: breakEven,
      profitableRoundShare: results.length === 0 ? null : profit / results.length,
      peakBankrollMinor: peak,
      lowestBankrollMinor: lowest,
      maxDrawdownMinor,
      maxDrawdownFraction,
      longestLosingStreak,
      legs: legSummaries,
    },
  };
}

// ---------------------------------------------------------------------------
// API contracts
// ---------------------------------------------------------------------------

const isoInstant = z.string().transform((text, ctx) => {
  const instant = parseIsoDateTimeWithOffset(text.trim());
  if (typeof instant !== 'number') {
    ctx.addIssue({
      code: 'custom',
      message: 'must be an ISO-8601 date-time with an explicit offset, e.g. 2026-01-31T00:00:00Z',
    });
    return z.NEVER;
  }
  return new Date(instant).toISOString();
});

/**
 * Rounds a backtest may replay. A single source is REQUIRED (rounds from different sources
 * cannot be interleaved into one trustworthy sequence). Filtering by multiplier is
 * deliberately NOT offered: selecting rounds by their own outcome would leak the result
 * into the selection.
 */
const sourceField = z.string().trim().min(1).max(MAX_SOURCE_LENGTH);
const eventRangeRefinement = {
  check: (d: { eventFrom: string | null; eventTo: string | null }) =>
    d.eventFrom === null || d.eventTo === null || d.eventFrom < d.eventTo,
  params: { message: 'eventFrom must be earlier than eventTo', path: ['eventFrom'] },
};

export const backtestDatasetSchema = z
  .object({
    source: sourceField,
    importId: z.number().int().positive().nullable().default(null),
    eventFrom: isoInstant.nullable().default(null),
    eventTo: isoInstant.nullable().default(null),
  })
  .strict()
  .refine(eventRangeRefinement.check, eventRangeRefinement.params);
export type BacktestDataset = z.infer<typeof backtestDatasetSchema>;

/** Same dataset fields as query-string text, for GET /api/simulations/dataset. */
export const backtestDatasetQuerySchema = z
  .object({
    source: sourceField,
    importId: z.coerce
      .number()
      .int()
      .positive()
      .optional()
      .transform((v) => v ?? null),
    eventFrom: isoInstant.optional().transform((v) => v ?? null),
    eventTo: isoInstant.optional().transform((v) => v ?? null),
  })
  .strict()
  .refine(eventRangeRefinement.check, eventRangeRefinement.params);

export const backtestRequestSchema = z
  .object({
    strategy: twoLegStrategyConfigSchema,
    settings: simulationSettingsSchema,
    dataset: backtestDatasetSchema,
  })
  .strict()
  .superRefine((req, ctx) => {
    if (req.strategy.currency !== req.settings.currency) {
      ctx.addIssue({
        code: 'custom',
        message: 'strategy and settings currencies differ',
        path: ['settings', 'currency'],
      });
    }
    const enabled = LEG_KEYS.filter((k) => req.strategy.legs[k].enabled);
    for (const key of enabled) {
      if (req.strategy.legs[key].stakeMinor > req.settings.startingBankrollMinor) {
        ctx.addIssue({
          code: 'custom',
          message: `Leg ${key} stake exceeds the starting bankroll`,
          path: ['strategy', 'legs', key, 'stakeMinor'],
        });
      }
    }
    const total = enabled.reduce((s, k) => s + req.strategy.legs[k].stakeMinor, 0);
    if (
      req.settings.insufficientBankrollPolicy === 'stop_run' &&
      total > req.settings.startingBankrollMinor
    ) {
      ctx.addIssue({
        code: 'custom',
        message:
          'With the stop-run policy, the combined stakes must not exceed the starting bankroll',
        path: ['settings', 'insufficientBankrollPolicy'],
      });
    }
  });
export type BacktestRequest = z.infer<typeof backtestRequestSchema>;

export const ORDERING_RULE =
  'Single source; rounds replayed by event time ascending. Rounds without an event time are excluded; duplicate event times make the order ambiguous and are rejected.';

/** A dataset selection after validation (all optional fields resolved to null). */
export const resolvedDatasetSchema = z.object({
  source: z.string(),
  importId: z.number().int().nullable(),
  eventFrom: z.string().nullable(),
  eventTo: z.string().nullable(),
});

export const backtestDatasetReportSchema = z.object({
  dataset: resolvedDatasetSchema,
  /** Non-synthetic rounds matching the filters, dated or not. */
  roundsMatching: z.number().int().min(0),
  /** Matching rounds with an event time: these are replayed, in event-time order. */
  roundsEligible: z.number().int().min(0),
  excludedNoEventTime: z.number().int().min(0),
  excludedSynthetic: z.number().int().min(0),
  /** Number of event-time values shared by two or more eligible rounds. */
  duplicateEventTimes: z.number().int().min(0),
  firstEventAt: z.string().nullable(),
  lastEventAt: z.string().nullable(),
  orderable: z.boolean(),
  /** Why the selection cannot be replayed, or null when orderable. */
  problem: z.string().nullable(),
  orderingRule: z.string(),
  maxRounds: z.number().int(),
});
export type BacktestDatasetReport = z.infer<typeof backtestDatasetReportSchema>;

const legSummarySchema = z.object({
  leg: z.enum(LEG_KEYS),
  label: z.string(),
  enabled: z.boolean(),
  stakeMinor: z.number().int(),
  cashoutTargetX100: z.number().int(),
  placed: z.number().int(),
  wins: z.number().int(),
  losses: z.number().int(),
  skipped: z.number().int(),
  stakedMinor: z.number().int(),
  grossReturnMinor: z.number().int(),
  netMinor: z.number().int(),
  targetReachedShare: z.number().min(0).max(1).nullable(),
});

export const backtestSummarySchema = z.object({
  currency: currencyCodeSchema,
  roundsAvailable: z.number().int(),
  roundsReplayed: z.number().int(),
  roundsNotReplayed: z.number().int(),
  stopReason: z.enum(STOP_REASONS),
  startingBankrollMinor: z.number().int(),
  endingBankrollMinor: z.number().int(),
  totalStakedMinor: z.number().int(),
  totalReturnedMinor: z.number().int(),
  netProfitMinor: z.number().int(),
  returnOnStartingBankroll: z.number(),
  roundsWithProfit: z.number().int(),
  roundsWithLoss: z.number().int(),
  roundsBreakEven: z.number().int(),
  profitableRoundShare: z.number().min(0).max(1).nullable(),
  peakBankrollMinor: z.number().int(),
  lowestBankrollMinor: z.number().int(),
  maxDrawdownMinor: z.number().int(),
  maxDrawdownFraction: z.number().min(0).max(1),
  longestLosingStreak: z.number().int(),
  legs: z.array(legSummarySchema),
});

export const simulationRunDtoSchema = z.object({
  id: z.number().int(),
  status: z.enum(['completed', 'failed']),
  createdAt: z.string(),
  completedAt: z.string().nullable(),
  errorMessage: z.string().nullable(),
  strategy: twoLegStrategyConfigSchema,
  settings: simulationSettingsSchema,
  /** The dataset selection as requested. */
  datasetRequest: resolvedDatasetSchema,
  /** What the selection resolved to at run time; null if the run failed before that. */
  dataset: backtestDatasetReportSchema.nullable(),
  /** SHA-256 of the ordered (roundId, multiplierX100, eventAt) list that was replayed. */
  datasetSha256: z.string().nullable(),
  summary: backtestSummarySchema.nullable(),
});
export type SimulationRunDto = z.infer<typeof simulationRunDtoSchema>;

export const simulationRunsListSchema = z.object({
  items: z.array(simulationRunDtoSchema),
  total: z.number().int(),
  limit: z.number().int(),
  offset: z.number().int(),
});

export const simulationRunsQuerySchema = z
  .object({
    limit: z.coerce.number().int().min(1).max(100).default(20),
    offset: z.coerce.number().int().min(0).max(10_000_000).default(0),
  })
  .strict();

export const ledgerQuerySchema = z
  .object({
    limit: z.coerce.number().int().min(1).max(500).default(100),
    offset: z.coerce.number().int().min(0).max(10_000_000).default(0),
  })
  .strict();

const ledgerLegSchema = z.object({
  leg: z.enum(LEG_KEYS),
  result: z.enum(['win', 'loss', 'skipped']),
  stakeMinor: z.number().int(),
  cashoutTargetX100: z.number().int(),
  grossReturnMinor: z.number().int(),
  netMinor: z.number().int(),
});

export const ledgerResponseSchema = z.object({
  runId: z.number().int(),
  currency: currencyCodeSchema,
  rounds: z.array(
    z.object({
      sequenceNo: z.number().int(),
      roundId: z.number().int(),
      eventAt: z.string().nullable(),
      multiplierX100: z.number().int(),
      bankrollBeforeMinor: z.number().int(),
      bankrollAfterMinor: z.number().int(),
      roundNetMinor: z.number().int(),
      legs: z.array(ledgerLegSchema),
    }),
  ),
  totalRounds: z.number().int(),
  limit: z.number().int(),
  offset: z.number().int(),
});
export type LedgerResponse = z.infer<typeof ledgerResponseSchema>;
