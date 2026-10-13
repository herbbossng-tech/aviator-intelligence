import {
  ANALYSIS_QUANTILE_LEVELS_BPS,
  blockBootstrapSummarySchema,
  MOVING_BLOCK_ALGORITHM_VERSION,
  movingBlockLayout,
  resolvedDatasetSchema,
  simulationSettingsSchema,
  stakingIdentity,
  stakingPlanSchema,
  twoLegStrategyConfigSchema,
  type BlockAnalysisDto,
  type BlockBootstrapSummary,
  type SimulationRunDto,
} from '@aviator/shared';
import { z } from 'zod';
import type { Db } from '../connection.js';
import { StoredDataError } from '../storedDataError.js';
import { configSnapshot } from './analyses.js';

/** Algorithm versions this build can interpret. */
const SUPPORTED_ALGORITHM_VERSIONS: readonly string[] = [MOVING_BLOCK_ALGORITHM_VERSION];

export interface NewBlockAnalysis {
  run: SimulationRunDto;
  datasetSha256: string;
  summary: BlockBootstrapSummary;
  createdAt: string;
  completedAt: string;
}

/** Inserts one completed block analysis as a single row (atomic). */
export function insertBlockAnalysis(db: Db, a: NewBlockAnalysis): number {
  return Number(
    db
      .prepare(
        `INSERT INTO simulation_block_bootstrap_analyses (
           simulation_run_id, status, method, algorithm_version, seed, paths, sample_size,
           block_length, dataset_sha256, config_json, summary_json, created_at, completed_at)
         VALUES (?, 'completed', 'moving_block_bootstrap', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        a.run.id,
        a.summary.algorithmVersion,
        a.summary.seed,
        a.summary.paths,
        a.summary.sample.size,
        a.summary.resampling.blockLength,
        a.datasetSha256,
        JSON.stringify(configSnapshot(a.run)),
        JSON.stringify(a.summary),
        a.createdAt,
        a.completedAt,
      ).lastInsertRowid,
  );
}

interface BlockAnalysisRow {
  id: number;
  simulation_run_id: number;
  method: string;
  algorithm_version: string;
  seed: number;
  paths: number;
  sample_size: number;
  block_length: number;
  dataset_sha256: string;
  config_json: string;
  summary_json: string;
  created_at: string;
  completed_at: string;
}

const COLUMNS =
  'id, simulation_run_id, method, algorithm_version, seed, paths, sample_size, block_length, dataset_sha256, config_json, summary_json, created_at, completed_at';

const storedConfigSchema = z
  .object({
    strategy: twoLegStrategyConfigSchema,
    settings: simulationSettingsSchema,
    datasetRequest: resolvedDatasetSchema,
    /** Present exactly for runs with a staking plan. */
    staking: stakingPlanSchema.optional(),
  })
  .strict();

type Distribution = BlockBootstrapSummary['endingBankrollMinor'];

/** Ordered, at exactly the standard quantile levels. */
function ordered(d: Distribution): boolean {
  if (
    d.quantiles.length !== ANALYSIS_QUANTILE_LEVELS_BPS.length ||
    d.quantiles.some((q, i) => q.levelBps !== ANALYSIS_QUANTILE_LEVELS_BPS[i])
  ) {
    return false;
  }
  const values = [d.min, ...d.quantiles.map((q) => q.value), d.max];
  return values.every((v, i) => i === 0 || values[i - 1]! <= v);
}

/**
 * Every stored row is checked on read against its run and for internal consistency, and is
 * never repaired, skipped or recomputed:
 * - the method and algorithm version are ones this build interprets;
 * - the configuration snapshot (strategy, settings, dataset selection, staking plan) and the
 *   dataset fingerprint equal the run's;
 * - the summary passes the shared schema, and its seed, paths, sample size, block length and
 *   version equal the row's columns;
 * - the sample size is the run's eligible sample (fixed by its fingerprint);
 * - the resampling layout (K, L, S) is the one the block length and sample size imply;
 * - every distribution is ordered at the standard quantile levels, and every count sums to
 *   the number of paths;
 * - the observed snapshot is the run's own summary, and the configured-boundary counts are
 *   exactly the run's configured stops with their stop-reason counts;
 * - the staking metadata names exactly the run's progressions (absent for a flat run).
 * A row that fails is reported as StoredDataError (HTTP 500 stored_data_invalid).
 */
function toDto(row: BlockAnalysisRow, run: SimulationRunDto): BlockAnalysisDto {
  try {
    if (row.method !== 'moving_block_bootstrap') throw new Error('unexpected method');
    if (!SUPPORTED_ALGORITHM_VERSIONS.includes(row.algorithm_version)) {
      throw new Error(`unsupported algorithm version ${JSON.stringify(row.algorithm_version)}`);
    }
    const config = storedConfigSchema.parse(JSON.parse(row.config_json));
    if (
      JSON.stringify(config.strategy) !== JSON.stringify(run.strategy) ||
      JSON.stringify(config.settings) !== JSON.stringify(run.settings) ||
      JSON.stringify(config.datasetRequest) !== JSON.stringify(run.datasetRequest) ||
      JSON.stringify(config.staking ?? null) !== JSON.stringify(run.staking)
    ) {
      throw new Error("the stored configuration differs from the run's");
    }
    if (row.dataset_sha256 !== run.datasetSha256) {
      throw new Error("the stored fingerprint differs from the run's");
    }
    const s = blockBootstrapSummarySchema.parse(JSON.parse(row.summary_json));
    if (
      s.algorithmVersion !== row.algorithm_version ||
      s.seed !== row.seed ||
      s.paths !== row.paths ||
      s.sample.size !== row.sample_size ||
      s.pathLength !== row.sample_size ||
      s.resampling.blockLength !== row.block_length
    ) {
      throw new Error('the row columns differ from the summary');
    }
    if (run.dataset !== null && row.sample_size !== run.dataset.roundsEligible) {
      throw new Error("the sample size differs from the run's eligible sample");
    }
    const layout = movingBlockLayout(row.sample_size, row.block_length);
    if (
      s.resampling.blocksPerPath !== layout.blocksPerPath ||
      s.resampling.lastBlockLength !== layout.lastBlockLength ||
      s.resampling.candidateStarts !== layout.candidateStarts
    ) {
      throw new Error('the resampling layout does not follow from the block length');
    }
    const distributions = [
      s.endingBankrollMinor,
      s.maxDrawdownFraction,
      s.maxDrawdownMinor,
      s.roundsReplayed,
      s.longestLosingStreak,
    ];
    if (!distributions.every(ordered)) throw new Error('a distribution is not ordered');
    const sum = (values: number[]) => values.reduce((a, b) => a + b, 0);
    if (
      sum(Object.values(s.stopReasons)) !== s.paths ||
      s.netOutcome.denominator !== s.paths ||
      s.netOutcome.positive + s.netOutcome.zero + s.netOutcome.negative !== s.paths ||
      s.observed.denominator !== s.paths ||
      s.observed.pathsEndingBelow + s.observed.pathsEndingEqual + s.observed.pathsEndingAbove !==
        s.paths
    ) {
      throw new Error('the counts do not add up to the number of paths');
    }
    const r = run.summary;
    if (
      r === null ||
      s.observed.endingBankrollMinor !== r.endingBankrollMinor ||
      s.observed.netProfitMinor !== r.netProfitMinor ||
      s.observed.maxDrawdownFraction !== r.maxDrawdownFraction ||
      s.observed.maxDrawdownMinor !== r.maxDrawdownMinor ||
      s.observed.roundsReplayed !== r.roundsReplayed ||
      s.observed.stopReason !== r.stopReason
    ) {
      throw new Error("the observed snapshot differs from the run's summary");
    }
    const { risk } = run.settings;
    const lower = s.configuredBoundaries.lowerBankrollStop;
    const drawdown = s.configuredBoundaries.maxDrawdownStop;
    if (
      (lower === null
        ? risk.stopBelowBankrollMinor !== null
        : lower.thresholdMinor !== risk.stopBelowBankrollMinor ||
          lower.count !== s.stopReasons.stop_below ||
          lower.denominator !== s.paths) ||
      (drawdown === null
        ? risk.maxDrawdownBps !== null
        : drawdown.thresholdBps !== risk.maxDrawdownBps ||
          drawdown.count !== s.stopReasons.max_drawdown ||
          drawdown.denominator !== s.paths)
    ) {
      throw new Error("the configured boundaries do not match the run's stops");
    }
    if ((s.staking === undefined) !== (run.staking === null)) {
      throw new Error("the summary's staking metadata does not match the run's plan");
    }
    if (s.staking !== undefined && run.staking !== null) {
      const identity = stakingIdentity(run.staking);
      for (const key of ['A', 'B'] as const) {
        const leg = s.staking.legs[key];
        const id = identity[key];
        if (
          leg === null || id === null
            ? leg !== id
            : leg.mode !== id.mode ||
              leg.configKey !== id.configKey ||
              leg.denominator !== s.paths ||
              leg.pathsStoppedByLimit > s.paths ||
              leg.pathsWithBankrollSkips > s.paths
        ) {
          throw new Error("the summary's staking metadata does not match the run's plan");
        }
      }
    }
    return {
      id: row.id,
      simulationRunId: row.simulation_run_id,
      status: 'completed',
      method: 'moving_block_bootstrap',
      createdAt: row.created_at,
      completedAt: row.completed_at,
      algorithmVersion: row.algorithm_version,
      seed: row.seed,
      paths: row.paths,
      blockLength: row.block_length,
      sampleSize: row.sample_size,
      datasetSha256: row.dataset_sha256,
      summary: s,
    };
  } catch (error) {
    throw new StoredDataError(
      { simulationRunId: row.simulation_run_id, blockAnalysisId: row.id },
      error,
    );
  }
}

export function listBlockAnalyses(
  db: Db,
  run: SimulationRunDto,
  { limit, offset }: { limit: number; offset: number },
): { items: BlockAnalysisDto[]; total: number } {
  const rows = db
    .prepare(
      `SELECT ${COLUMNS} FROM simulation_block_bootstrap_analyses WHERE simulation_run_id = ?
        ORDER BY id DESC LIMIT ? OFFSET ?`,
    )
    .all(run.id, limit, offset) as BlockAnalysisRow[];
  const { total } = db
    .prepare(
      'SELECT COUNT(*) AS total FROM simulation_block_bootstrap_analyses WHERE simulation_run_id = ?',
    )
    .get(run.id) as { total: number };
  return { items: rows.map((row) => toDto(row, run)), total };
}

export function getBlockAnalysis(
  db: Db,
  run: SimulationRunDto,
  analysisId: number,
): BlockAnalysisDto | null {
  const row = db
    .prepare(
      `SELECT ${COLUMNS} FROM simulation_block_bootstrap_analyses
        WHERE id = ? AND simulation_run_id = ?`,
    )
    .get(analysisId, run.id) as BlockAnalysisRow | undefined;
  return row ? toDto(row, run) : null;
}
