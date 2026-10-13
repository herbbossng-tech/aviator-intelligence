import {
  backtestSummarySchema,
  ORDERING_RULE,
  simulationSettingsSchema,
  twoLegStrategyConfigSchema,
  backtestDatasetReportSchema,
  resolvedDatasetSchema,
  legProgressionEntrySchema,
  LEG_KEYS,
  progressionConfigKey,
  stakingPlanIssues,
  stakingPlanSchema,
  type BacktestDataset,
  type BacktestDatasetReport,
  type BacktestResult,
  type BacktestRound,
  type LedgerResponse,
  type SimulationRunDto,
  type SimulationSettings,
  type StakingPlan,
  type TwoLegStrategyConfig,
} from '@aviator/shared';
import { z } from 'zod';
import type { Db } from '../connection.js';
import { StoredDataError } from '../storedDataError.js';
import { roundFilterSql, type RoundFilter } from './rounds.js';

const CANONICAL_EVENT_AT = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/;

/**
 * True only for the exact form the app writes, new Date(...).toISOString(), AND a real
 * instant: '2026-02-30T00:00:00.000Z' or '...T24:00:00.000Z' have the right shape but
 * JavaScript normalises them to a different instant, so they fail the round trip. Only such
 * values sort correctly as text.
 */
export function isCanonicalEventAt(value: unknown): boolean {
  if (typeof value !== 'string' || !CANONICAL_EVENT_AT.test(value)) return false;
  const instant = Date.parse(value);
  return !Number.isNaN(instant) && new Date(instant).toISOString() === value;
}

const withEventAtCheck = new WeakSet<Db>();

/** Registers isCanonicalEventAt as a deterministic SQL function on this connection. */
function registerEventAtCheck(db: Db): void {
  if (withEventAtCheck.has(db)) return;
  db.function('aviator_is_canonical_event_at', { deterministic: true }, (value: unknown) =>
    isCanonicalEventAt(value) ? 1 : 0,
  );
  withEventAtCheck.add(db);
}

/** A replayed round plus the identity fields that go into the dataset fingerprint. */
export interface ReplayRound extends BacktestRound {
  sourceRoundId: string | null;
}

function toFilter(dataset: BacktestDataset): RoundFilter {
  return {
    source: dataset.source,
    importId: dataset.importId ?? undefined,
    eventFrom: dataset.eventFrom ?? undefined,
    eventTo: dataset.eventTo ?? undefined,
  };
}

/**
 * Describes what a dataset selection resolves to, and whether it can be replayed in a
 * single unambiguous order. Read-only. Call inside a transaction together with
 * loadReplayRounds() so both describe the same snapshot.
 *
 * - Eligible: non-synthetic rounds of the source (and import, if set) with an event time
 *   inside the optional [eventFrom, eventTo) range.
 * - Undated rounds of the source/import cannot be placed in time; they are excluded and
 *   counted (the date range, if any, cannot be evaluated for them).
 * - Synthetic test fixtures matching the selection are excluded and counted.
 */
export function getDatasetReport(
  db: Db,
  dataset: BacktestDataset,
  maxRounds: number,
): BacktestDatasetReport {
  registerEventAtCheck(db);
  const filter = toFilter(dataset);
  const dated = roundFilterSql(filter);
  const eligible = db
    .prepare(
      `SELECT COUNT(*) AS n, MIN(event_at) AS first, MAX(event_at) AS last
         FROM rounds WHERE ${dated.where} AND event_at IS NOT NULL`,
    )
    .get(...dated.params) as { n: number; first: string | null; last: string | null };
  const duplicates = (
    db
      .prepare(
        `SELECT COUNT(*) AS n FROM (
           SELECT event_at FROM rounds WHERE ${dated.where} AND event_at IS NOT NULL
            GROUP BY event_at HAVING COUNT(*) > 1)`,
      )
      .get(...dated.params) as { n: number }
  ).n;
  const nonCanonical = (
    db
      .prepare(
        `SELECT COUNT(*) AS n FROM rounds WHERE ${dated.where} AND event_at IS NOT NULL
            AND aviator_is_canonical_event_at(event_at) = 0`,
      )
      .get(...dated.params) as { n: number }
  ).n;
  const undatedSql = roundFilterSql({ source: filter.source, importId: filter.importId });
  const undated = (
    db
      .prepare(`SELECT COUNT(*) AS n FROM rounds WHERE ${undatedSql.where} AND event_at IS NULL`)
      .get(...undatedSql.params) as { n: number }
  ).n;
  const syntheticSql = roundFilterSql(filter, { synthetic: 'only' });
  const synthetic = (
    db
      .prepare(`SELECT COUNT(*) AS n FROM rounds WHERE ${syntheticSql.where}`)
      .get(...syntheticSql.params) as { n: number }
  ).n;

  let problem: string | null = null;
  if (eligible.n === 0) {
    problem =
      undated > 0
        ? 'None of the matching rounds has an event time, so they cannot be replayed in order.'
        : 'No eligible rounds match this selection.';
  } else if (nonCanonical > 0) {
    problem = `${nonCanonical} eligible round(s) have an event time that is not a real instant in the canonical UTC form this app writes, so the replay order cannot be trusted. Correct or re-import those rounds.`;
  } else if (duplicates > 0) {
    problem = `${duplicates} event time(s) are shared by more than one round, so the replay order is ambiguous. Narrow the selection (for example by import or date range).`;
  } else if (eligible.n > maxRounds) {
    problem = `The selection contains ${eligible.n} eligible rounds; a backtest replays at most ${maxRounds}. Narrow the date range.`;
  }

  return {
    dataset: {
      source: dataset.source,
      importId: dataset.importId,
      eventFrom: dataset.eventFrom,
      eventTo: dataset.eventTo,
    },
    roundsMatching: eligible.n + undated,
    roundsEligible: eligible.n,
    excludedNoEventTime: undated,
    excludedSynthetic: synthetic,
    duplicateEventTimes: duplicates,
    nonCanonicalEventTimes: nonCanonical,
    firstEventAt: eligible.first,
    lastEventAt: eligible.last,
    orderable: problem === null,
    problem,
    orderingRule: ORDERING_RULE,
    maxRounds,
  };
}

/** Eligible rounds in replay order (event time ascending; ties are rejected by the report). */
export function loadReplayRounds(db: Db, dataset: BacktestDataset): ReplayRound[] {
  const { where, params } = roundFilterSql(toFilter(dataset));
  return db
    .prepare(
      `SELECT id AS roundId, multiplier_x100 AS multiplierX100, event_at AS eventAt,
              source_round_id AS sourceRoundId
         FROM rounds WHERE ${where} AND event_at IS NOT NULL
        ORDER BY event_at ASC, id ASC`,
    )
    .all(...params) as ReplayRound[];
}

export interface CompletedRunInput {
  strategy: TwoLegStrategyConfig;
  settings: SimulationSettings;
  /** The staking plan the replay used, or null for flat stakes. */
  staking: StakingPlan | null;
  datasetRequest: BacktestDataset;
  report: BacktestDatasetReport;
  datasetSha256: string;
  result: BacktestResult;
  startedAt: string;
  completedAt: string;
}

/** Inserts a completed run and its full ledger. Call inside a transaction. */
export function insertCompletedRun(db: Db, input: CompletedRunInput): number {
  const { summary } = input.result;
  const runId = Number(
    db
      .prepare(
        `INSERT INTO simulation_runs (
           strategy_snapshot_json, settings_json, dataset_json, currency, starting_bankroll_minor,
           status, ending_bankroll_minor, rounds_processed, created_at, started_at, completed_at,
           summary_json, stop_reason, dataset_sha256, staking_json)
         VALUES (?, ?, ?, ?, ?, 'completed', ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        JSON.stringify(input.strategy),
        JSON.stringify(input.settings),
        JSON.stringify({ request: input.datasetRequest, report: input.report }),
        summary.currency,
        summary.startingBankrollMinor,
        summary.endingBankrollMinor,
        summary.roundsReplayed,
        input.startedAt,
        input.startedAt,
        input.completedAt,
        JSON.stringify(summary),
        summary.stopReason,
        input.datasetSha256,
        input.staking === null ? null : JSON.stringify(input.staking),
      ).lastInsertRowid,
  );
  const insertEntry = db.prepare(
    `INSERT INTO ledger_entries (
       simulation_run_id, round_id, sequence_no, leg_key, stake_minor, cashout_target_x100,
       gross_return_minor, net_minor, result, bankroll_after_minor, created_at,
       round_multiplier_x100, bankroll_before_minor, progression_step, requested_stake_minor,
       cycle_loss_before_minor, cycle_loss_after_minor, skip_reason, progression_active)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  );
  for (const round of input.result.rounds) {
    for (const leg of round.legs) {
      insertEntry.run(
        runId,
        round.roundId,
        round.sequenceNo,
        leg.leg,
        leg.stakeMinor,
        leg.cashoutTargetX100,
        leg.grossReturnMinor,
        leg.netMinor,
        leg.result,
        round.bankrollAfterMinor,
        input.completedAt,
        round.multiplierX100,
        round.bankrollBeforeMinor,
        leg.progression?.step ?? null,
        leg.progression?.requestedStakeMinor ?? null,
        leg.progression?.cycleLossBeforeMinor ?? null,
        leg.progression?.cycleLossAfterMinor ?? null,
        leg.progression?.skipReason ?? null,
        leg.progression === undefined ? null : leg.progression.active ? 1 : 0,
      );
    }
  }
  return runId;
}

export interface FailedRunInput {
  strategy: TwoLegStrategyConfig;
  settings: SimulationSettings;
  staking: StakingPlan | null;
  datasetRequest: BacktestDataset;
  report: BacktestDatasetReport | null;
  errorMessage: string;
  startedAt: string;
}

/** Records a failed run with no summary and no ledger entries. */
export function insertFailedRun(db: Db, input: FailedRunInput): number {
  return Number(
    db
      .prepare(
        `INSERT INTO simulation_runs (
           strategy_snapshot_json, settings_json, dataset_json, currency, starting_bankroll_minor,
           status, error_message, created_at, started_at, staking_json)
         VALUES (?, ?, ?, ?, ?, 'failed', ?, ?, ?, ?)`,
      )
      .run(
        JSON.stringify(input.strategy),
        JSON.stringify(input.settings),
        JSON.stringify({ request: input.datasetRequest, report: input.report }),
        input.settings.currency,
        input.settings.startingBankrollMinor,
        input.errorMessage,
        input.startedAt,
        input.startedAt,
        input.staking === null ? null : JSON.stringify(input.staking),
      ).lastInsertRowid,
  );
}

interface RunRow {
  id: number;
  status: string;
  created_at: string;
  completed_at: string | null;
  error_message: string | null;
  strategy_snapshot_json: string;
  settings_json: string;
  dataset_json: string;
  dataset_sha256: string | null;
  summary_json: string | null;
  staking_json: string | null;
}

const storedDatasetSchema = z.object({
  request: resolvedDatasetSchema,
  report: backtestDatasetReportSchema.nullable(),
});

const RUN_COLUMNS =
  'id, status, created_at, completed_at, error_message, strategy_snapshot_json, settings_json, dataset_json, dataset_sha256, summary_json, staking_json';

/** Only runs written by the backtest service (completed or failed) are listed. */
const RUN_SCOPE = "status IN ('completed', 'failed')";

/**
 * Every stored JSON column is re-validated on read. A row that fails is reported as a
 * StoredDataError (HTTP 500 stored_data_invalid) rather than skipped, so a list is never
 * silently incomplete and a server-side data problem is never reported as a client error.
 */
function toRunDto(row: RunRow): SimulationRunDto {
  try {
    return parseRunRow(row);
  } catch (error) {
    throw new StoredDataError({ simulationRunId: row.id }, error);
  }
}

function parseRunRow(row: RunRow): SimulationRunDto {
  const dataset = storedDatasetSchema.parse(JSON.parse(row.dataset_json));
  const run: SimulationRunDto = {
    id: row.id,
    status: row.status === 'completed' ? 'completed' : 'failed',
    createdAt: row.created_at,
    completedAt: row.completed_at,
    errorMessage: row.error_message,
    strategy: twoLegStrategyConfigSchema.parse(JSON.parse(row.strategy_snapshot_json)),
    settings: simulationSettingsSchema.parse(JSON.parse(row.settings_json)),
    datasetRequest: dataset.request,
    dataset: dataset.report,
    datasetSha256: row.dataset_sha256,
    summary:
      row.summary_json === null ? null : backtestSummarySchema.parse(JSON.parse(row.summary_json)),
    staking:
      row.staking_json === null ? null : stakingPlanSchema.parse(JSON.parse(row.staking_json)),
  };
  checkStakingConsistency(run);
  return run;
}

/**
 * A stored plan must still fit the stored strategy, and a stored summary must describe exactly
 * the plan's progressions (same legs, modes and configuration keys). Nothing is repaired.
 */
function checkStakingConsistency({ staking, strategy, summary }: SimulationRunDto): void {
  if (staking !== null) {
    const issue = stakingPlanIssues(staking, strategy)[0];
    if (issue) throw new Error(`stored staking plan: ${issue.message}`);
  }
  if (summary === null) return;
  const progression = summary.progression;
  if ((progression === undefined) !== (staking === null)) {
    throw new Error('the stored summary does not match the stored staking plan');
  }
  if (progression === undefined || staking === null) return;
  for (const key of LEG_KEYS) {
    const config = staking.legs[key];
    const leg = progression.legs[key];
    if (config === null || leg === null) {
      if (config !== leg)
        throw new Error(`leg ${key}'s progression summary does not match the plan`);
      continue;
    }
    if (leg.mode !== config.mode || leg.configKey !== progressionConfigKey(config)) {
      throw new Error(`leg ${key}'s progression summary does not match the plan`);
    }
  }
}

export function listRuns(
  db: Db,
  { limit, offset }: { limit: number; offset: number },
): { items: SimulationRunDto[]; total: number } {
  const rows = db
    .prepare(
      `SELECT ${RUN_COLUMNS} FROM simulation_runs WHERE ${RUN_SCOPE} ORDER BY id DESC LIMIT ? OFFSET ?`,
    )
    .all(limit, offset) as RunRow[];
  const { total } = db
    .prepare(`SELECT COUNT(*) AS total FROM simulation_runs WHERE ${RUN_SCOPE}`)
    .get() as { total: number };
  return { items: rows.map(toRunDto), total };
}

export function getRun(db: Db, id: number): SimulationRunDto | null {
  const row = db
    .prepare(`SELECT ${RUN_COLUMNS} FROM simulation_runs WHERE id = ? AND ${RUN_SCOPE}`)
    .get(id) as RunRow | undefined;
  return row ? toRunDto(row) : null;
}

interface LedgerRow {
  sequence_no: number;
  round_id: number;
  event_at: string | null;
  round_multiplier_x100: number;
  bankroll_before_minor: number;
  bankroll_after_minor: number;
  leg_key: 'A' | 'B';
  result: 'win' | 'loss' | 'skipped';
  stake_minor: number;
  cashout_target_x100: number;
  gross_return_minor: number;
  net_minor: number;
  progression_step: number | null;
  requested_stake_minor: number | null;
  cycle_loss_before_minor: number | null;
  cycle_loss_after_minor: number | null;
  skip_reason: string | null;
  progression_active: number | null;
}

/** The progression fields of a ledger row, validated (a leg without a progression has none). */
function progressionOf(row: LedgerRow, run: SimulationRunDto) {
  if (row.progression_step === null) {
    if (run.staking?.legs[row.leg_key]) {
      throw new Error(`leg ${row.leg_key} has a progression but its ledger row has no fields`);
    }
    return undefined;
  }
  if (!run.staking?.legs[row.leg_key]) {
    throw new Error(`leg ${row.leg_key} has progression fields but no progression`);
  }
  return legProgressionEntrySchema.parse({
    step: row.progression_step,
    requestedStakeMinor: row.requested_stake_minor,
    cycleLossBeforeMinor: row.cycle_loss_before_minor,
    cycleLossAfterMinor: row.cycle_loss_after_minor,
    skipReason: row.skip_reason,
    active: row.progression_active === 1 ? true : row.progression_active === 0 ? false : null,
  });
}

/**
 * One page of a run's ledger, grouped by replayed round. Sequence numbers are contiguous
 * from 0, so a page of rounds is a sequence_no range.
 */
export function getLedgerPage(
  db: Db,
  run: SimulationRunDto,
  { limit, offset }: { limit: number; offset: number },
): LedgerResponse {
  const rows = db
    .prepare(
      `SELECT l.sequence_no, l.round_id, r.event_at, l.round_multiplier_x100,
              l.bankroll_before_minor, l.bankroll_after_minor, l.leg_key, l.result,
              l.stake_minor, l.cashout_target_x100, l.gross_return_minor, l.net_minor,
              l.progression_step, l.requested_stake_minor, l.cycle_loss_before_minor,
              l.cycle_loss_after_minor, l.skip_reason, l.progression_active
         FROM ledger_entries l JOIN rounds r ON r.id = l.round_id
        WHERE l.simulation_run_id = ? AND l.sequence_no >= ? AND l.sequence_no < ?
        ORDER BY l.sequence_no, l.leg_key`,
    )
    .all(run.id, offset, offset + limit) as LedgerRow[];
  const rounds: LedgerResponse['rounds'] = [];
  for (const row of rows) {
    let current = rounds.at(-1);
    if (current?.sequenceNo !== row.sequence_no) {
      current = {
        sequenceNo: row.sequence_no,
        roundId: row.round_id,
        eventAt: row.event_at,
        multiplierX100: row.round_multiplier_x100,
        bankrollBeforeMinor: row.bankroll_before_minor,
        bankrollAfterMinor: row.bankroll_after_minor,
        roundNetMinor: row.bankroll_after_minor - row.bankroll_before_minor,
        legs: [],
      };
      rounds.push(current);
    }
    let progression;
    try {
      progression = progressionOf(row, run);
    } catch (error) {
      throw new StoredDataError({ simulationRunId: run.id }, error);
    }
    current.legs.push({
      leg: row.leg_key,
      result: row.result,
      stakeMinor: row.stake_minor,
      cashoutTargetX100: row.cashout_target_x100,
      grossReturnMinor: row.gross_return_minor,
      netMinor: row.net_minor,
      ...(progression === undefined ? {} : { progression }),
    });
  }
  return {
    runId: run.id,
    currency: run.settings.currency,
    rounds,
    totalRounds: run.summary?.roundsReplayed ?? 0,
    limit,
    offset,
  };
}
