import {
  assertRobustnessWorkload,
  BacktestLimitError,
  maxWindowsForSample,
  ROBUSTNESS_RESULT_SCHEMA_VERSION,
  RobustnessLimitError,
  runBlockRobustness,
  verifyBlockRobustnessResult,
  type BlockRobustnessResult,
  type RobustnessAnalysisDto,
  type RobustnessOptions,
  type SimulationRunDto,
} from '@aviator/shared';
import type { Db } from '../db/connection.js';
import { getRobustnessAnalysis, insertRobustnessAnalysis } from '../db/repositories/robustness.js';
import { getDatasetReport, loadReplayRounds } from '../db/repositories/simulations.js';
import { HttpError } from '../http/errors.js';
import { hashReplayRounds } from './service.js';

export interface RobustnessRunOptions {
  now: () => Date;
  maxRounds: number;
  log: (message: string, error: unknown) => void;
  /** Test seam: runs after computing and verifying, before the write transaction. */
  afterCompute?: () => void;
}

export const FAILED_ROBUSTNESS_MESSAGE =
  'The robustness analysis could not be completed. Nothing was stored.';

const DATASET_CHANGED_MESSAGE =
  'The rounds this run selected have changed since it ran (its dataset fingerprint no longer matches), so they are no longer the dataset the run used. Run a new backtest and analyse that instead.';

function tooFewRounds(sampleSize: number, windows: number): HttpError {
  const maxWindows = maxWindowsForSample(sampleSize);
  return new HttpError(
    422,
    'robustness_sample_too_small',
    maxWindows === 0
      ? `This run's sample has ${sampleSize} rounds; at least 60 are needed for 2 blocks of 30.`
      : `This run's sample has ${sampleSize} rounds, so at most ${maxWindows} blocks of at least 30 rounds are possible (${windows} requested).`,
    { maxWindows, sampleSize },
  );
}

/** Refuses a request the sample cannot support, before any replay. */
function preflight(sampleSize: number, windows: number): void {
  if (windows > maxWindowsForSample(sampleSize)) throw tooFewRounds(sampleSize, windows);
  try {
    assertRobustnessWorkload(sampleSize, 1);
  } catch (error) {
    if (error instanceof RobustnessLimitError) {
      throw new HttpError(422, 'robustness_too_large', error.message);
    }
    throw error;
  }
}

/**
 * Replays a completed run's eligible dataset in chronological blocks and stores the result:
 *
 * 1. Only a completed run with a summary and fingerprint is eligible (409 otherwise).
 * 2. Limits are checked from the run's recorded sample size before anything is read.
 * 3. The dataset is read in one read transaction; its fingerprint must equal the run's
 *    (409 dataset_changed), so the source is exactly what the run replayed.
 * 4. Limits are checked again against the rounds actually read.
 * 5. The shared engine computes the result outside any transaction (no lock is held).
 * 6. The result is verified strictly: partition, chronology, reconciliation, the source
 *    rounds at every boundary, and equality of the full-sample replay with the run's summary.
 * 7. In one IMMEDIATE write transaction the rounds are fingerprinted again (a change since
 *    step 3 is refused, 409) and the result is inserted as one row (the insert trigger also
 *    requires a completed run with the same fingerprint).
 * Any failure stores nothing. Historical rounds and the run itself are only read.
 */
export function runAndStoreRobustness(
  db: Db,
  run: SimulationRunDto,
  request: RobustnessOptions,
  { now, maxRounds, log, afterCompute }: RobustnessRunOptions,
): RobustnessAnalysisDto {
  if (run.status !== 'completed' || run.summary === null || run.datasetSha256 === null) {
    throw new HttpError(
      409,
      'run_not_analyzable',
      'Only a completed run can be analysed; this run failed and has no results.',
    );
  }
  const datasetSha256 = run.datasetSha256;
  preflight(run.dataset?.roundsEligible ?? 0, request.windows);

  const createdAt = now().toISOString();
  const { rounds, problem } = db.transaction(() => {
    const report = getDatasetReport(db, run.datasetRequest, maxRounds);
    if (!report.orderable) return { rounds: null, problem: report.problem };
    return { rounds: loadReplayRounds(db, run.datasetRequest), problem: null };
  })();
  if (rounds === null || hashReplayRounds(run.datasetRequest.source, rounds) !== datasetSha256) {
    throw new HttpError(
      409,
      'dataset_changed',
      DATASET_CHANGED_MESSAGE,
      problem === null ? undefined : { problem },
    );
  }
  preflight(rounds.length, request.windows);

  let result: BlockRobustnessResult;
  try {
    result = runBlockRobustness(rounds, run.strategy, run.settings, request);
    verifyBlockRobustnessResult(result, {
      windows: request.windows,
      sampleSize: rounds.length,
      strategy: run.strategy,
      settings: run.settings,
      observedSummary: run.summary,
      rounds,
    });
  } catch (error) {
    if (error instanceof BacktestLimitError) {
      throw new HttpError(422, 'simulation_out_of_range', error.message);
    }
    log('Robustness analysis failed', error);
    throw new HttpError(500, 'robustness_failed', FAILED_ROBUSTNESS_MESSAGE);
  }
  afterCompute?.();

  let id: number | null;
  try {
    id = db
      .transaction(() => {
        // Re-fingerprint inside the write transaction: nothing can change the rounds between
        // this check and the insert.
        const current = loadReplayRounds(db, run.datasetRequest);
        if (hashReplayRounds(run.datasetRequest.source, current) !== datasetSha256) return null;
        return insertRobustnessAnalysis(db, {
          run,
          datasetSha256,
          resultSchemaVersion: ROBUSTNESS_RESULT_SCHEMA_VERSION,
          result,
          createdAt,
          completedAt: now().toISOString(),
        });
      })
      .immediate();
  } catch (error) {
    log('Storing the robustness analysis failed', error);
    throw new HttpError(500, 'robustness_failed', FAILED_ROBUSTNESS_MESSAGE);
  }
  if (id === null) throw new HttpError(409, 'dataset_changed', DATASET_CHANGED_MESSAGE);
  const stored = getRobustnessAnalysis(db, run, id);
  if (!stored) throw new Error('robustness analysis missing after insert');
  return stored;
}
