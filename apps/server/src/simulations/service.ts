import { createHash } from 'node:crypto';
import {
  BacktestLimitError,
  runBacktest,
  type BacktestDatasetReport,
  type BacktestRequest,
  type SimulationRunDto,
} from '@aviator/shared';
import type { Db } from '../db/connection.js';
import {
  getDatasetReport,
  getRun,
  insertCompletedRun,
  insertFailedRun,
  loadReplayRounds,
  type ReplayRound,
} from '../db/repositories/simulations.js';
import { HttpError } from '../http/errors.js';

export const DATASET_FINGERPRINT_VERSION = 'aviator-intelligence/backtest-dataset/v1';

/**
 * SHA-256 over a canonical, unambiguous encoding of the dataset's eligible rounds in replay
 * order (all of them, even if a stop ended the replay early): a version line, the JSON-encoded source, then one JSON array per round
 * [roundId, sourceRoundId, multiplierX100, eventAt]. JSON escaping means no field value can
 * be confused with a separator. It identifies the data representation that was hashed; it
 * does not prove the data is authentic.
 */
export function hashReplayRounds(source: string, rounds: readonly ReplayRound[]): string {
  const hash = createHash('sha256');
  hash.update(`${DATASET_FINGERPRINT_VERSION}\n${JSON.stringify(source)}\n`);
  for (const r of rounds) {
    hash.update(`${JSON.stringify([r.roundId, r.sourceRoundId, r.multiplierX100, r.eventAt])}\n`);
  }
  return hash.digest('hex');
}

class NotOrderableError extends Error {
  constructor(readonly report: BacktestDatasetReport) {
    super(report.problem ?? 'not orderable');
  }
}

export interface RunOptions {
  now: () => Date;
  maxRounds: number;
  log: (message: string, error: unknown) => void;
}

export const FAILED_RUN_MESSAGE =
  'The backtest could not be completed. The transaction was rolled back and no ledger entries were stored.';

/**
 * Runs and stores a backtest in ONE transaction: reading the dataset, replaying it, and
 * writing the completed run with its full ledger commit together or not at all. Historical
 * rounds are only read. A selection that cannot be ordered is rejected (422) without storing
 * anything. Any other failure rolls back and records a separate 'failed' run with a generic
 * message and no ledger; internal details are only logged.
 */
export function runAndStoreBacktest(
  db: Db,
  request: BacktestRequest,
  { now, maxRounds, log }: RunOptions,
): SimulationRunDto {
  const startedAt = now().toISOString();
  let report: BacktestDatasetReport | null = null;
  let runId: number;
  try {
    runId = db.transaction(() => {
      report = getDatasetReport(db, request.dataset, maxRounds);
      if (!report.orderable) throw new NotOrderableError(report);
      const rounds = loadReplayRounds(db, request.dataset);
      const result = runBacktest(rounds, request.strategy, request.settings, request.staking);
      return insertCompletedRun(db, {
        strategy: request.strategy,
        settings: request.settings,
        staking: request.staking,
        datasetRequest: request.dataset,
        report,
        datasetSha256: hashReplayRounds(request.dataset.source, rounds),
        result,
        startedAt,
        completedAt: now().toISOString(),
      });
    })();
  } catch (error) {
    if (error instanceof BacktestLimitError) {
      // A deterministic property of the request and data, not a failure: nothing is stored.
      throw new HttpError(422, 'simulation_out_of_range', error.message);
    }
    if (error instanceof NotOrderableError) {
      throw new HttpError(422, 'dataset_not_replayable', error.message, {
        dataset: error.report,
      });
    }
    log('Backtest failed and was rolled back', error);
    try {
      insertFailedRun(db, {
        strategy: request.strategy,
        settings: request.settings,
        staking: request.staking,
        datasetRequest: request.dataset,
        report,
        errorMessage: FAILED_RUN_MESSAGE,
        startedAt,
      });
    } catch (recordError) {
      log('Could not record the failed backtest', recordError);
    }
    throw new HttpError(500, 'simulation_failed', FAILED_RUN_MESSAGE);
  }
  const stored = getRun(db, runId);
  if (!stored) throw new Error('simulation run missing after commit');
  return stored;
}
