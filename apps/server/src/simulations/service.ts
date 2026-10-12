import { createHash } from 'node:crypto';
import {
  runBacktest,
  type BacktestDatasetReport,
  type BacktestRequest,
  type BacktestRound,
  type SimulationRunDto,
} from '@aviator/shared';
import type { Db } from '../db/connection.js';
import {
  getDatasetReport,
  getRun,
  insertCompletedRun,
  insertFailedRun,
  loadReplayRounds,
} from '../db/repositories/simulations.js';
import { HttpError } from '../http/errors.js';

/** SHA-256 of the ordered (roundId, multiplierX100, eventAt) list: identical input, identical hash. */
export function hashReplayRounds(rounds: readonly BacktestRound[]): string {
  const hash = createHash('sha256');
  for (const r of rounds) hash.update(`${r.roundId},${r.multiplierX100},${r.eventAt}\n`);
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
      const result = runBacktest(rounds, request.strategy, request.settings);
      return insertCompletedRun(db, {
        strategy: request.strategy,
        settings: request.settings,
        datasetRequest: request.dataset,
        report,
        datasetSha256: hashReplayRounds(rounds),
        result,
        startedAt,
        completedAt: now().toISOString(),
      });
    })();
  } catch (error) {
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
