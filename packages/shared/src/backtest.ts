import { z } from 'zod';
import {
  LEG_KEYS,
  twoLegStrategyConfigSchema,
  type LegKey,
  type TwoLegStrategyConfig,
} from './legs.js';
import { currencyCodeSchema } from './money.js';
import { MAX_SOURCE_LENGTH, parseIsoDateTimeWithOffset } from './rounds.js';
import {
  createProgressionStepper,
  PROGRESSION_MODES,
  type ProgressionMode,
  type ProgressionState,
  type ProgressionStepper,
} from './progression.js';
import { settleLeg, simulationSettingsSchema, type SimulationSettings } from './simulation.js';
import {
  LEDGER_SKIP_REASONS,
  stakingPlanIssues,
  stakingPlanSchema,
  type LedgerSkipReason,
  type StakingPlan,
} from './staking.js';

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
  bankroll_exhausted:
    'The virtual bankroll could no longer cover the smallest stake an enabled leg requested.',
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
  /** Present only for a leg staked by a progression (see docs/PROGRESSION.md). */
  progression?: LegProgressionEntry | undefined;
}

/**
 * A progression leg's decision in one round. `stakeMinor` on the entry is always the stake
 * actually PLACED (0 when skipped); `requestedStakeMinor` is what the progression asked for.
 */
export interface LegProgressionEntry {
  /** Zero-based progression step of this decision. */
  step: number;
  /** The stake the progression requested (null if it has no further step). */
  requestedStakeMinor: number | null;
  /** The leg's losses in its current cycle before this round. */
  cycleLossBeforeMinor: number;
  /** After this round's result (0 after a win; unchanged when skipped). */
  cycleLossAfterMinor: number;
  /** Why nothing was placed, or null when the stake was placed. */
  skipReason: LedgerSkipReason | null;
  /** False once a permanent limit has made this leg's progression inactive for the run. */
  active: boolean;
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
  /**
   * Largest fall from a running peak relative to that peak, (peak - bankroll) / peak, 0..1.
   * Tracked separately from maxDrawdownMinor: the largest relative fall can come from a
   * different (smaller) episode than the largest absolute fall.
   */
  maxDrawdownFraction: number;
  longestLosingStreak: number;
  legs: LegSummary[];
  /** Present only when the run used a staking plan. */
  progression?: ProgressionRunSummary | undefined;
}

export interface LegProgressionSummary {
  mode: ProgressionMode;
  /** Deterministic key of this leg's progression configuration (see progressionConfigKey). */
  configKey: string;
  /** `active`, or the permanent state the leg ended in. */
  finalStatus: 'active' | 'blocked' | 'exhausted';
  finalBlockReason: Exclude<LedgerSkipReason, 'insufficient_bankroll'> | null;
  finalStep: number;
  finalCycleLossMinor: number;
  /** Highest step at which a stake was placed (null if none was). */
  maxStepPlaced: number | null;
  /** Wins, each of which reset the progression (equals the leg's wins). */
  cyclesCompleted: number;
  /** Skipped because the start-of-round bankroll could not fund the requested stake. */
  skippedInsufficientBankroll: number;
  /** Skipped because a permanent limit had made the leg inactive. */
  skippedInactive: number;
  /** Replay position of the first round the leg was inactive in, or null. */
  inactiveFromSequenceNo: number | null;
}

export interface ProgressionRunSummary {
  legs: { A: LegProgressionSummary | null; B: LegProgressionSummary | null };
  /** Replayed rounds in which no leg placed a stake. */
  roundsWithoutStake: number;
}

export interface BacktestResult {
  rounds: BacktestRoundResult[];
  summary: BacktestSummary;
}

/**
 * Thrown when exact results would leave the range of integers a JavaScript number (and the
 * JSON API) can represent exactly (Number.MAX_SAFE_INTEGER minor units). The run is refused
 * rather than reported with rounded figures.
 */
export class BacktestLimitError extends RangeError {
  constructor(message: string) {
    super(message);
    this.name = 'BacktestLimitError';
  }
}

const MAX_SAFE = BigInt(Number.MAX_SAFE_INTEGER);

function toSafeNumber(value: bigint, what: string): number {
  if (value > MAX_SAFE || value < -MAX_SAFE) {
    throw new BacktestLimitError(
      `${what} exceeds the exactly representable range; use smaller stakes or fewer rounds`,
    );
  }
  return Number(value);
}

function legOrder(strategy: TwoLegStrategyConfig) {
  return LEG_KEYS.map((key) => ({ key, ...strategy.legs[key] }));
}

/** Validates inputs that the schemas cannot check on their own. Throws RangeError. */
export function assertReplayableRounds(rounds: readonly BacktestRound[]): void {
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

/** A replayed round before historical identity (round id, event time) is attached. */
export type ReplayedRound = Omit<BacktestRoundResult, 'roundId' | 'eventAt'>;

/** One enabled leg during a replay: a flat stake, or a progression with its own state. */
interface LegRuntime {
  key: LegKey;
  label: string;
  stakeMinor: number;
  cashoutTargetX100: number;
  stepper: ProgressionStepper | null;
  state: ProgressionState | null;
  maxStepPlaced: number | null;
  skippedInsufficientBankroll: number;
  skippedInactive: number;
  inactiveFromSequenceNo: number | null;
}

/** What a leg asks to stake this round, decided before the round's multiplier is read. */
type LegRequest =
  | {
      leg: LegRuntime;
      kind: 'stake';
      stakeMinor: number;
      /** Present for progression legs. */
      step: number | null;
      cycleLossBeforeMinor: number;
    }
  | {
      leg: LegRuntime;
      kind: 'inactive';
      reason: Exclude<LedgerSkipReason, 'insufficient_bankroll'>;
      step: number;
      requestedStakeMinor: number | null;
      cycleLossMinor: number;
    };

function requestFor(leg: LegRuntime): LegRequest {
  if (leg.stepper === null || leg.state === null) {
    return { leg, kind: 'stake', stakeMinor: leg.stakeMinor, step: null, cycleLossBeforeMinor: 0 };
  }
  const request = leg.stepper.request(leg.state);
  if (request.kind === 'stake') {
    return {
      leg,
      kind: 'stake',
      stakeMinor: request.stakeMinor,
      step: request.step,
      cycleLossBeforeMinor: request.cycleLossBeforeMinor,
    };
  }
  // A permanent limit: the leg stays inactive for the rest of the run (the state is terminal).
  leg.state = request.state;
  return {
    leg,
    kind: 'inactive',
    reason: request.reason,
    step: request.step,
    requestedStakeMinor: request.kind === 'blocked' ? request.requestedStakeMinor : null,
    cycleLossMinor: request.cycleLossMinor,
  };
}

/**
 * The single replay loop behind both the historical backtest and the uncertainty
 * analysis: staking, settlement (settleLeg), bankroll accounting, stops and metrics.
 * Inputs must already be validated (parsed strategy and settings with matching
 * currencies, and a staking plan checked against the strategy); multipliers are validated
 * by settleLeg as they are settled.
 * `recordRounds` keeps the per-round ledger; resampled paths turn it off to bound memory.
 *
 * Staking: a leg without a progression stakes its configured amount every round (the
 * original behaviour). A progression leg requests its stake from its own progression state,
 * before the round's multiplier is read, and only that leg's own settled result advances
 * (loss) or resets (win) it. Stakes are funded from the bankroll at the start of the round,
 * A first, then B, so neither leg can use the other's same-round return.
 */
function replayCore(
  count: number,
  multiplierAt: (index: number) => number,
  strategy: TwoLegStrategyConfig,
  settings: SimulationSettings,
  recordRounds: boolean,
  staking: StakingPlan | null = null,
): { rounds: ReplayedRound[]; summary: BacktestSummary } {
  const legs = legOrder(strategy);
  const runtimes: LegRuntime[] = legs
    .filter((l) => l.enabled)
    .map((l) => {
      const config = staking?.legs[l.key] ?? null;
      const stepper = config === null ? null : createProgressionStepper(config);
      return {
        key: l.key,
        label: l.label,
        stakeMinor: l.stakeMinor,
        cashoutTargetX100: l.cashoutTargetX100,
        stepper,
        state: stepper === null ? null : stepper.initialState,
        maxStepPlaced: null,
        skippedInsufficientBankroll: 0,
        skippedInactive: 0,
        inactiveFromSequenceNo: null,
      };
    });
  const { risk } = settings;

  const legTotals = new Map(
    legs.map((l) => [
      l.key,
      {
        placed: 0,
        wins: 0,
        losses: 0,
        skipped: 0,
        // Running totals are exact BigInts; they can exceed 2^53 long before any bankroll does.
        stakedMinor: 0n,
        grossReturnMinor: 0n,
        netMinor: 0n,
      },
    ]),
  );
  const results: ReplayedRound[] = [];
  let replayed = 0;
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
  let roundsWithoutStake = 0;
  let stopReason: StopReason = 'completed_all_rounds';

  for (let index = 0; index < count; index++) {
    // Pre-round stops depend only on the configuration and the bankroll so far.
    if (risk.maxRounds !== null && index >= risk.maxRounds) {
      stopReason = 'max_rounds';
      break;
    }
    // Every stake for this round is decided here, before the round's multiplier is read.
    const requests = runtimes.map(requestFor);
    let minStake = Infinity;
    let totalStake = 0;
    for (const r of requests) {
      if (r.kind !== 'stake') continue;
      minStake = Math.min(minStake, r.stakeMinor);
      totalStake += r.stakeMinor;
    }
    // With every leg inactive (permanent progression limits) nothing is requested: the round
    // is replayed without stakes rather than stopped as if the bankroll had run out.
    if (minStake !== Infinity && bankroll < minStake) {
      stopReason = 'bankroll_exhausted';
      break;
    }
    if (settings.insufficientBankrollPolicy === 'stop_run' && bankroll < totalStake) {
      stopReason = 'insufficient_bankroll';
      break;
    }
    const multiplierX100 = multiplierAt(index);

    let available = bankroll;
    const entries: BacktestLegEntry[] = [];
    let placedAny = false;
    for (const request of requests) {
      const { leg } = request;
      const totals = legTotals.get(leg.key)!;
      if (request.kind === 'inactive') {
        totals.skipped += 1;
        leg.skippedInactive += 1;
        leg.inactiveFromSequenceNo ??= index;
        entries.push({
          leg: leg.key,
          result: 'skipped',
          stakeMinor: 0,
          cashoutTargetX100: leg.cashoutTargetX100,
          grossReturnMinor: 0,
          netMinor: 0,
          progression: {
            step: request.step,
            requestedStakeMinor: request.requestedStakeMinor,
            cycleLossBeforeMinor: request.cycleLossMinor,
            cycleLossAfterMinor: request.cycleLossMinor,
            skipReason: request.reason,
            active: false,
          },
        });
        continue;
      }
      if (request.stakeMinor > available) {
        // Only reachable under 'skip_leg': this leg cannot be funded this round. A progression
        // leg is neither advanced nor reset: no stake was placed, so there is no result.
        const entry: BacktestLegEntry = {
          leg: leg.key,
          result: 'skipped',
          stakeMinor: 0,
          cashoutTargetX100: leg.cashoutTargetX100,
          grossReturnMinor: 0,
          netMinor: 0,
        };
        if (request.step !== null) {
          leg.skippedInsufficientBankroll += 1;
          entry.progression = {
            step: request.step,
            requestedStakeMinor: request.stakeMinor,
            cycleLossBeforeMinor: request.cycleLossBeforeMinor,
            cycleLossAfterMinor: request.cycleLossBeforeMinor,
            skipReason: 'insufficient_bankroll',
            active: true,
          };
        }
        entries.push(entry);
        totals.skipped += 1;
        continue;
      }
      available -= request.stakeMinor;
      placedAny = true;
      let settled: ReturnType<typeof settleLeg>;
      try {
        settled = settleLeg(
          { stakeMinor: request.stakeMinor, cashoutTargetX100: leg.cashoutTargetX100 },
          multiplierX100,
        );
      } catch (error) {
        if (error instanceof RangeError && /representable/.test(error.message)) {
          throw new BacktestLimitError(
            `Leg ${leg.key}'s return in round ${index + 1}: ${error.message}`,
          );
        }
        throw error;
      }
      const entry: BacktestLegEntry = {
        leg: leg.key,
        result: settled.result,
        stakeMinor: request.stakeMinor,
        cashoutTargetX100: leg.cashoutTargetX100,
        grossReturnMinor: settled.grossReturnMinor,
        netMinor: settled.netMinor,
      };
      if (leg.stepper !== null && leg.state !== null && request.step !== null) {
        // Only this leg's own result moves its own progression.
        leg.state = leg.stepper.settle(leg.state, settled.result);
        leg.maxStepPlaced = Math.max(leg.maxStepPlaced ?? 0, request.step);
        entry.progression = {
          step: request.step,
          requestedStakeMinor: request.stakeMinor,
          cycleLossBeforeMinor: request.cycleLossBeforeMinor,
          cycleLossAfterMinor: leg.state.cycleLossMinor,
          skipReason: null,
          active: true,
        };
      }
      entries.push(entry);
      totals.placed += 1;
      totals.stakedMinor += BigInt(request.stakeMinor);
      totals.grossReturnMinor += BigInt(settled.grossReturnMinor);
      totals.netMinor += BigInt(settled.netMinor);
      if (settled.result === 'win') totals.wins += 1;
      else totals.losses += 1;
    }
    if (!placedAny) roundsWithoutStake += 1;

    const roundNet = entries.reduce((s, e) => s + BigInt(e.netMinor), 0n);
    const roundNetMinor = toSafeNumber(roundNet, 'A round net');
    const after = toSafeNumber(BigInt(bankroll) + roundNet, 'The bankroll');
    if (after < 0) throw new Error('Invariant violated: bankroll went negative');
    if (recordRounds) {
      results.push({
        sequenceNo: index,
        multiplierX100,
        bankrollBeforeMinor: bankroll,
        bankrollAfterMinor: after,
        roundNetMinor,
        legs: entries,
      });
    }
    replayed += 1;
    bankroll = after;

    if (roundNetMinor > 0) profit += 1;
    else if (roundNetMinor < 0) loss += 1;
    else breakEven += 1;
    streak = roundNetMinor < 0 ? streak + 1 : 0;
    longestLosingStreak = Math.max(longestLosingStreak, streak);
    peak = Math.max(peak, bankroll);
    lowest = Math.min(lowest, bankroll);
    maxDrawdownMinor = Math.max(maxDrawdownMinor, peak - bankroll);
    // peak >= starting bankroll > 0, so the ratio is defined.
    maxDrawdownFraction = Math.max(maxDrawdownFraction, (peak - bankroll) / peak);

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

  let staked = 0n;
  let returned = 0n;
  const legSummaries: LegSummary[] = legs.map((l) => {
    const t = legTotals.get(l.key)!;
    if (t.netMinor !== t.grossReturnMinor - t.stakedMinor || t.wins + t.losses !== t.placed) {
      throw new Error(`Invariant violated: leg ${l.key} totals do not reconcile`);
    }
    staked += t.stakedMinor;
    returned += t.grossReturnMinor;
    return {
      leg: l.key,
      label: l.label,
      enabled: l.enabled,
      stakeMinor: l.stakeMinor,
      cashoutTargetX100: l.cashoutTargetX100,
      placed: t.placed,
      wins: t.wins,
      losses: t.losses,
      skipped: t.skipped,
      stakedMinor: toSafeNumber(t.stakedMinor, `Leg ${l.key}'s total stake`),
      grossReturnMinor: toSafeNumber(t.grossReturnMinor, `Leg ${l.key}'s total return`),
      netMinor: toSafeNumber(t.netMinor, `Leg ${l.key}'s net`),
      targetReachedShare: t.placed === 0 ? null : t.wins / t.placed,
    };
  });
  const net = BigInt(bankroll) - BigInt(settings.startingBankrollMinor);
  // Exact reconciliation: ending - starting = total returned - total staked.
  if (net !== returned - staked) {
    throw new Error('Invariant violated: net profit != returned - staked');
  }
  const totalStakedMinor = toSafeNumber(staked, 'The total stake');
  const totalReturnedMinor = toSafeNumber(returned, 'The total return');
  const netProfitMinor = toSafeNumber(net, 'The net profit');
  const summary: BacktestSummary = {
    currency: strategy.currency,
    roundsAvailable: count,
    roundsReplayed: replayed,
    roundsNotReplayed: count - replayed,
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
    profitableRoundShare: replayed === 0 ? null : profit / replayed,
    peakBankrollMinor: peak,
    lowestBankrollMinor: lowest,
    maxDrawdownMinor,
    maxDrawdownFraction,
    longestLosingStreak,
    legs: legSummaries,
  };
  if (staking !== null) {
    const legProgression = (key: LegKey): LegProgressionSummary | null => {
      const leg = runtimes.find((r) => r.key === key);
      if (!leg || leg.stepper === null || leg.state === null) return null;
      const totals = legSummaries.find((s) => s.leg === key)!;
      if (leg.skippedInactive + leg.skippedInsufficientBankroll !== totals.skipped) {
        throw new Error(`Invariant violated: leg ${key} skips do not reconcile`);
      }
      if (leg.state.cyclesCompleted !== totals.wins) {
        throw new Error(`Invariant violated: leg ${key} cycles do not reconcile`);
      }
      const status = leg.state.status;
      return {
        mode: leg.stepper.config.mode,
        configKey: leg.stepper.configKey,
        finalStatus: status === 'blocked' || status === 'exhausted' ? status : 'active',
        finalBlockReason:
          status === 'exhausted'
            ? 'sequence_exhausted'
            : status === 'blocked'
              ? (leg.state.blockReason as LegProgressionSummary['finalBlockReason'])
              : null,
        finalStep: leg.state.step,
        finalCycleLossMinor: leg.state.cycleLossMinor,
        maxStepPlaced: leg.maxStepPlaced,
        cyclesCompleted: leg.state.cyclesCompleted,
        skippedInsufficientBankroll: leg.skippedInsufficientBankroll,
        skippedInactive: leg.skippedInactive,
        inactiveFromSequenceNo: leg.inactiveFromSequenceNo,
      };
    };
    summary.progression = {
      legs: { A: legProgression('A'), B: legProgression('B') },
      roundsWithoutStake,
    };
  }
  return { rounds: results, summary };
}

function parseConfig(strategyInput: TwoLegStrategyConfig, settingsInput: SimulationSettings) {
  const strategy = twoLegStrategyConfigSchema.parse(strategyInput);
  const settings = simulationSettingsSchema.parse(settingsInput);
  if (strategy.currency !== settings.currency) {
    throw new RangeError('Strategy and settings must use the same currency');
  }
  return { strategy, settings };
}

/** Validates a staking plan against the strategy it applies to. Throws RangeError. */
function parseStaking(
  stakingInput: StakingPlan | null,
  strategy: TwoLegStrategyConfig,
): StakingPlan | null {
  if (stakingInput === null) return null;
  const staking = stakingPlanSchema.parse(stakingInput);
  const issues = stakingPlanIssues(staking, strategy);
  if (issues.length > 0) throw new RangeError(issues.map((i) => i.message).join('; '));
  return staking;
}

export function runBacktest(
  rounds: readonly BacktestRound[],
  strategyInput: TwoLegStrategyConfig,
  settingsInput: SimulationSettings,
  stakingInput: StakingPlan | null = null,
): BacktestResult {
  const { strategy, settings } = parseConfig(strategyInput, settingsInput);
  const staking = parseStaking(stakingInput, strategy);
  assertReplayableRounds(rounds);
  const { rounds: replayed, summary } = replayCore(
    rounds.length,
    (index) => rounds[index]!.multiplierX100,
    strategy,
    settings,
    true,
    staking,
  );
  return {
    rounds: replayed.map((r) => ({
      ...r,
      roundId: rounds[r.sequenceNo]!.roundId,
      eventAt: rounds[r.sequenceNo]!.eventAt,
    })),
    summary,
  };
}

/**
 * Validates a configuration once and returns a function that replays a bare multiplier
 * sequence through the same replay loop as runBacktest, returning only the summary (no
 * per-round ledger). Used for resampled paths, which have no historical round identity.
 */
export function createSummaryReplayer(
  strategyInput: TwoLegStrategyConfig,
  settingsInput: SimulationSettings,
): (multipliers: ArrayLike<number>) => BacktestSummary {
  const { strategy, settings } = parseConfig(strategyInput, settingsInput);
  return (multipliers) => {
    if (multipliers.length > MAX_BACKTEST_ROUNDS) {
      throw new RangeError(`A replay covers at most ${MAX_BACKTEST_ROUNDS} rounds`);
    }
    return replayCore(multipliers.length, (index) => multipliers[index]!, strategy, settings, false)
      .summary;
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
    /** Optional per-leg progressions; omitted or null means flat stakes, as before. */
    staking: stakingPlanSchema.nullable().default(null),
  })
  .strict()
  .superRefine((req, ctx) => {
    if (req.staking !== null) {
      for (const issue of stakingPlanIssues(req.staking, req.strategy)) {
        ctx.addIssue({ code: 'custom', message: issue.message, path: issue.path });
      }
    }
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
/** What a client sends: optional dataset fields may be omitted. */
export type BacktestRequestInput = z.input<typeof backtestRequestSchema>;

export const ORDERING_RULE =
  'Single source; rounds replayed by event time ascending. Rounds without an event time are excluded; duplicate or non-canonical event times make the order unreliable and are rejected.';

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
  /** Matching rounds with an event time: the replay order (a stop may end the replay early). */
  roundsEligible: z.number().int().min(0),
  excludedNoEventTime: z.number().int().min(0),
  excludedSynthetic: z.number().int().min(0),
  /** Number of event-time values shared by two or more eligible rounds. */
  duplicateEventTimes: z.number().int().min(0),
  /**
   * Eligible rounds whose stored event time is not a real instant in the canonical UTC form
   * the app writes (YYYY-MM-DDTHH:MM:SS.sssZ, as produced by Date#toISOString). Text
   * ordering is only reliable for that form; impossible dates such as 30 February count here.
   */
  nonCanonicalEventTimes: z.number().int().min(0),
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

const legProgressionSummarySchema = z.object({
  mode: z.enum(PROGRESSION_MODES),
  configKey: z.string(),
  finalStatus: z.enum(['active', 'blocked', 'exhausted']),
  finalBlockReason: z.enum(LEDGER_SKIP_REASONS).exclude(['insufficient_bankroll']).nullable(),
  finalStep: z.number().int().min(0),
  finalCycleLossMinor: z.number().int().min(0),
  maxStepPlaced: z.number().int().min(0).nullable(),
  cyclesCompleted: z.number().int().min(0),
  skippedInsufficientBankroll: z.number().int().min(0),
  skippedInactive: z.number().int().min(0),
  inactiveFromSequenceNo: z.number().int().min(0).nullable(),
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
  progression: z
    .object({
      legs: z.object({
        A: legProgressionSummarySchema.nullable(),
        B: legProgressionSummarySchema.nullable(),
      }),
      roundsWithoutStake: z.number().int().min(0),
    })
    .optional(),
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
  /**
   * SHA-256 of the dataset's eligible rounds in replay order (source, then each round's id,
   * source id, multiplier and event time), including rounds an early-stopped replay never reached.
   */
  datasetSha256: z.string().nullable(),
  summary: backtestSummarySchema.nullable(),
  /** The staking plan the run used; null for flat stakes (including every older run). */
  staking: stakingPlanSchema.nullable().default(null),
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

export const legProgressionEntrySchema = z
  .object({
    step: z.number().int().min(0),
    requestedStakeMinor: z.number().int().min(1).nullable(),
    cycleLossBeforeMinor: z.number().int().min(0),
    cycleLossAfterMinor: z.number().int().min(0),
    skipReason: z.enum(LEDGER_SKIP_REASONS).nullable(),
    active: z.boolean(),
  })
  .strict();

const ledgerLegSchema = z.object({
  leg: z.enum(LEG_KEYS),
  result: z.enum(['win', 'loss', 'skipped']),
  stakeMinor: z.number().int(),
  cashoutTargetX100: z.number().int(),
  grossReturnMinor: z.number().int(),
  netMinor: z.number().int(),
  progression: legProgressionEntrySchema.optional(),
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
