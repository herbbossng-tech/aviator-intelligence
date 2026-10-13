import {
  AnalysisLimitError,
  BacktestLimitError,
  maxBlockLength,
  maxPathsForSample,
  MIN_BLOCK_BOOTSTRAP_SAMPLE,
  runBlockBootstrap,
  type BlockAnalysisDto,
  type BlockAnalysisRequest,
  type SimulationRunDto,
} from '@aviator/shared';
import type { Db } from '../db/connection.js';
import { getBlockAnalysis, insertBlockAnalysis } from '../db/repositories/blockAnalyses.js';
import { getDatasetReport, loadReplayRounds } from '../db/repositories/simulations.js';
import { HttpError } from '../http/errors.js';
import { hashReplayRounds } from './service.js';

export interface BlockAnalysisOptions {
  now: () => Date;
  maxRounds: number;
  log: (message: string, error: unknown) => void;
  /** Test seam: runs after computing, before the write transaction. */
  afterCompute?: () => void;
}

export const FAILED_BLOCK_ANALYSIS_MESSAGE =
  'The block bootstrap analysis could not be completed. Nothing was stored.';

const DATASET_CHANGED_MESSAGE =
  'The rounds this run selected have changed since it ran (its dataset fingerprint no longer matches), so they are no longer the dataset the run used. Run a new backtest and analyse that instead.';

/**
 * Refuses a request the sample cannot support, before any replay: too few rounds, a block
 * length above ⌊n / 10⌋ (or 500), or more paths than the work limit allows.
 */
function preflight(sampleSize: number, request: BlockAnalysisRequest): void {
  if (sampleSize < MIN_BLOCK_BOOTSTRAP_SAMPLE) {
    throw new HttpError(
      422,
      'analysis_sample_too_small',
      `This run's sample has ${sampleSize} rounds; a block bootstrap needs at least ${MIN_BLOCK_BOOTSTRAP_SAMPLE}.`,
      { sampleSize, minSampleSize: MIN_BLOCK_BOOTSTRAP_SAMPLE },
    );
  }
  const maxLength = maxBlockLength(sampleSize);
  if (request.blockLength > maxLength) {
    throw new HttpError(
      422,
      'block_length_too_large',
      `This run's sample has ${sampleSize} rounds, so the block length can be at most ${maxLength} (at least 10 blocks per path).`,
      { maxBlockLength: maxLength, sampleSize },
    );
  }
  const maxPaths = maxPathsForSample(sampleSize);
  if (request.paths > maxPaths) {
    throw new HttpError(
      422,
      'analysis_too_large',
      `This run's sample has ${sampleSize} rounds, so at most ${maxPaths} paths are allowed (the work limit is paths x rounds).`,
      { maxPaths, sampleSize },
    );
  }
}

/**
 * Resamples a completed run's eligible dataset by the moving-block bootstrap and stores the
 * result. The server computes everything itself; clients only choose paths, seed and b.
 *
 * 1. Only a completed run with a summary and fingerprint is eligible (409 otherwise).
 * 2. Limits are checked from the run's recorded sample size before anything is read.
 * 3. The dataset is read in one read transaction; its fingerprint must equal the run's
 *    (409 dataset_changed), so the sample is exactly the run's dataset.
 * 4. Limits are checked again against the rounds actually read.
 * 5. The shared engine (runBlockBootstrap) computes the result outside any transaction,
 *    replaying every path with the run's own strategy, settings and staking plan.
 * 6. In one IMMEDIATE write transaction the rounds are fingerprinted again (a change since
 *    step 3 is refused, 409) and the result is inserted as one row; the insert trigger also
 *    requires a completed run with the same fingerprint.
 * 7. The row is read back through the same strict validation as every later read.
 * Any failure stores nothing. Historical rounds and the run itself are only read.
 */
export function runAndStoreBlockAnalysis(
  db: Db,
  run: SimulationRunDto,
  request: BlockAnalysisRequest,
  { now, maxRounds, log, afterCompute }: BlockAnalysisOptions,
): BlockAnalysisDto {
  if (run.status !== 'completed' || run.summary === null || run.datasetSha256 === null) {
    throw new HttpError(
      409,
      'run_not_analyzable',
      'Only a completed run can be analysed; this run failed and has no results.',
    );
  }
  const datasetSha256 = run.datasetSha256;
  preflight(run.dataset?.roundsEligible ?? 0, request);

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
  preflight(rounds.length, request);

  let summary;
  try {
    summary = runBlockBootstrap(
      rounds.map((r) => r.multiplierX100),
      run.strategy,
      run.settings,
      request,
      run.summary,
      run.staking,
    );
  } catch (error) {
    if (error instanceof BacktestLimitError) {
      throw new HttpError(422, 'simulation_out_of_range', error.message);
    }
    if (error instanceof AnalysisLimitError) {
      throw new HttpError(422, 'analysis_too_large', error.message, {
        maxPaths: maxPathsForSample(rounds.length),
      });
    }
    log('Block bootstrap analysis failed', error);
    throw new HttpError(500, 'block_analysis_failed', FAILED_BLOCK_ANALYSIS_MESSAGE);
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
        return insertBlockAnalysis(db, {
          run,
          datasetSha256,
          summary,
          createdAt,
          completedAt: now().toISOString(),
        });
      })
      .immediate();
  } catch (error) {
    log('Storing the block bootstrap analysis failed', error);
    throw new HttpError(500, 'block_analysis_failed', FAILED_BLOCK_ANALYSIS_MESSAGE);
  }
  if (id === null) throw new HttpError(409, 'dataset_changed', DATASET_CHANGED_MESSAGE);
  const stored = getBlockAnalysis(db, run, id);
  if (!stored) throw new Error('block analysis missing after insert');
  return stored;
}
