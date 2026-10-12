import {
  AnalysisLimitError,
  BacktestLimitError,
  maxPathsForSample,
  runBootstrap,
  type AnalysisSettings,
  type SimulationAnalysisDto,
  type SimulationRunDto,
} from '@aviator/shared';
import type { Db } from '../db/connection.js';
import { getAnalysis, insertAnalysis } from '../db/repositories/analyses.js';
import { getDatasetReport, loadReplayRounds } from '../db/repositories/simulations.js';
import { HttpError } from '../http/errors.js';
import { hashReplayRounds } from './service.js';

export interface AnalysisOptions {
  now: () => Date;
  maxRounds: number;
  log: (message: string, error: unknown) => void;
}

function tooLarge(sampleSize: number): HttpError {
  const maxPaths = maxPathsForSample(sampleSize);
  return new HttpError(
    422,
    'analysis_too_large',
    `This run's sample has ${sampleSize} rounds, so at most ${maxPaths} paths are allowed (the work limit is paths x rounds).`,
    { maxPaths, sampleSize },
  );
}

export const FAILED_ANALYSIS_MESSAGE =
  'The uncertainty analysis could not be completed. Nothing was stored.';

/**
 * Resamples the exact sample a completed run replayed. The run's dataset is read again and
 * its fingerprint must equal the run's stored fingerprint, so the "observed" result (the
 * run) and the resampled sample always describe the same data; otherwise 409.
 * Work limits are checked before any computation. Only a fully computed result is written,
 * as a single row; any failure stores nothing.
 */
export function runAndStoreAnalysis(
  db: Db,
  run: SimulationRunDto,
  settings: AnalysisSettings,
  { now, maxRounds, log }: AnalysisOptions,
): SimulationAnalysisDto {
  if (run.status !== 'completed' || run.summary === null || run.datasetSha256 === null) {
    throw new HttpError(
      409,
      'run_not_analyzable',
      'Only a completed run can be analysed; this run failed and has no results.',
    );
  }
  // Refuse oversized requests from the run's recorded sample size before reading anything.
  const recordedSize = run.dataset?.roundsEligible ?? 0;
  if (recordedSize > 0 && settings.paths > maxPathsForSample(recordedSize)) {
    throw tooLarge(recordedSize);
  }
  const createdAt = now().toISOString();
  const { rounds, problem } = db.transaction(() => {
    const report = getDatasetReport(db, run.datasetRequest, maxRounds);
    if (!report.orderable) return { rounds: null, problem: report.problem };
    return { rounds: loadReplayRounds(db, run.datasetRequest), problem: null };
  })();
  if (
    rounds === null ||
    hashReplayRounds(run.datasetRequest.source, rounds) !== run.datasetSha256
  ) {
    throw new HttpError(
      409,
      'dataset_changed',
      'The rounds this run selected have changed since it ran (its dataset fingerprint no longer matches), so they are not the sample the run replayed. Run a new backtest and analyse that instead.',
      problem === null ? undefined : { problem },
    );
  }
  const maxPaths = maxPathsForSample(rounds.length);
  if (settings.paths > maxPaths) throw tooLarge(rounds.length);

  let summary;
  try {
    summary = runBootstrap(
      rounds.map((r) => r.multiplierX100),
      run.strategy,
      run.settings,
      settings,
      run.summary,
    );
  } catch (error) {
    if (error instanceof BacktestLimitError) {
      throw new HttpError(422, 'simulation_out_of_range', error.message);
    }
    if (error instanceof AnalysisLimitError) {
      throw new HttpError(422, 'analysis_too_large', error.message, { maxPaths });
    }
    log('Uncertainty analysis failed', error);
    throw new HttpError(500, 'analysis_failed', FAILED_ANALYSIS_MESSAGE);
  }

  let id: number;
  try {
    id = insertAnalysis(db, {
      run,
      datasetSha256: run.datasetSha256,
      summary,
      createdAt,
      completedAt: now().toISOString(),
    });
  } catch (error) {
    log('Storing the uncertainty analysis failed', error);
    throw new HttpError(500, 'analysis_failed', FAILED_ANALYSIS_MESSAGE);
  }
  const stored = getAnalysis(db, run.id, id);
  if (!stored) throw new Error('analysis missing after insert');
  return stored;
}
