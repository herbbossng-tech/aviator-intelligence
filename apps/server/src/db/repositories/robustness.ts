import {
  resolvedDatasetSchema,
  simulationSettingsSchema,
  stakingPlanSchema,
  SUPPORTED_ROBUSTNESS_RESULT_SCHEMA_VERSIONS,
  twoLegStrategyConfigSchema,
  verifyBlockRobustnessResult,
  type BlockRobustnessResult,
  type RobustnessAnalysisDto,
  type SimulationRunDto,
} from '@aviator/shared';
import { z } from 'zod';
import type { Db } from '../connection.js';
import { configSnapshot } from './analyses.js';
import { StoredDataError } from '../storedDataError.js';

export interface NewRobustnessAnalysis {
  run: SimulationRunDto;
  datasetSha256: string;
  resultSchemaVersion: number;
  result: BlockRobustnessResult;
  createdAt: string;
  completedAt: string;
}

/** Inserts one completed, already verified robustness analysis as a single row (atomic). */
export function insertRobustnessAnalysis(db: Db, a: NewRobustnessAnalysis): number {
  return Number(
    db
      .prepare(
        `INSERT INTO simulation_robustness_analyses (
           simulation_run_id, status, method, algorithm_version, result_schema_version, windows,
           sample_size, dataset_sha256, config_json, result_json, created_at, completed_at)
         VALUES (?, 'completed', 'chronological_blocks', ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        a.run.id,
        a.result.algorithmVersion,
        a.resultSchemaVersion,
        a.result.windows,
        a.result.sampleSize,
        a.datasetSha256,
        JSON.stringify(configSnapshot(a.run)),
        JSON.stringify(a.result),
        a.createdAt,
        a.completedAt,
      ).lastInsertRowid,
  );
}

interface RobustnessRow {
  id: number;
  simulation_run_id: number;
  algorithm_version: string;
  result_schema_version: number;
  windows: number;
  sample_size: number;
  dataset_sha256: string;
  config_json: string;
  result_json: string;
  created_at: string;
  completed_at: string;
}

const COLUMNS =
  'id, simulation_run_id, algorithm_version, result_schema_version, windows, sample_size, dataset_sha256, config_json, result_json, created_at, completed_at';

const storedConfigSchema = z
  .object({
    strategy: twoLegStrategyConfigSchema,
    settings: simulationSettingsSchema,
    datasetRequest: resolvedDatasetSchema,
    /** Absent for flat-stake runs, and in every snapshot written before staking existed. */
    staking: stakingPlanSchema.optional(),
  })
  .strict();

/**
 * Every stored row is verified on read against its run: the result format version, the
 * configuration snapshot (it must equal the run's, staking plan included), the fingerprint, the declared columns,
 * and the full cross-field verification of the result, including that its full-sample replay
 * equals the run's stored summary. A row that fails is reported (StoredDataError, HTTP 500),
 * never repaired or skipped.
 */
function toDto(row: RobustnessRow, run: SimulationRunDto): RobustnessAnalysisDto {
  try {
    if (!SUPPORTED_ROBUSTNESS_RESULT_SCHEMA_VERSIONS.includes(row.result_schema_version)) {
      throw new Error(`unsupported result schema version ${row.result_schema_version}`);
    }
    if (run.status !== 'completed' || run.summary === null) {
      throw new Error('the run is not a completed run');
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
    const result = verifyBlockRobustnessResult(JSON.parse(row.result_json), {
      windows: row.windows,
      sampleSize: row.sample_size,
      strategy: config.strategy,
      settings: config.settings,
      staking: config.staking ?? null,
      observedSummary: run.summary,
    });
    if (result.algorithmVersion !== row.algorithm_version) {
      throw new Error('the algorithm version column differs from the result');
    }
    return {
      id: row.id,
      simulationRunId: row.simulation_run_id,
      status: 'completed',
      createdAt: row.created_at,
      completedAt: row.completed_at,
      algorithmVersion: row.algorithm_version,
      resultSchemaVersion: row.result_schema_version,
      windows: row.windows,
      sampleSize: row.sample_size,
      datasetSha256: row.dataset_sha256,
      result,
    };
  } catch (error) {
    throw new StoredDataError(
      { simulationRunId: row.simulation_run_id, robustnessAnalysisId: row.id },
      error,
    );
  }
}

export function listRobustnessAnalyses(
  db: Db,
  run: SimulationRunDto,
  { limit, offset, windows }: { limit: number; offset: number; windows?: number | undefined },
): { items: RobustnessAnalysisDto[]; total: number } {
  const where =
    windows === undefined ? 'simulation_run_id = ?' : 'simulation_run_id = ? AND windows = ?';
  const params = windows === undefined ? [run.id] : [run.id, windows];
  const rows = db
    .prepare(
      `SELECT ${COLUMNS} FROM simulation_robustness_analyses WHERE ${where}
        ORDER BY id DESC LIMIT ? OFFSET ?`,
    )
    .all(...params, limit, offset) as RobustnessRow[];
  const { total } = db
    .prepare(`SELECT COUNT(*) AS total FROM simulation_robustness_analyses WHERE ${where}`)
    .get(...params) as { total: number };
  return { items: rows.map((row) => toDto(row, run)), total };
}

export function getRobustnessAnalysis(
  db: Db,
  run: SimulationRunDto,
  analysisId: number,
): RobustnessAnalysisDto | null {
  const row = db
    .prepare(
      `SELECT ${COLUMNS} FROM simulation_robustness_analyses WHERE id = ? AND simulation_run_id = ?`,
    )
    .get(analysisId, run.id) as RobustnessRow | undefined;
  return row ? toDto(row, run) : null;
}

/** Deletes one analysis of this run. Returns false if there was no such analysis. */
export function deleteRobustnessAnalysis(db: Db, runId: number, analysisId: number): boolean {
  return (
    db
      .prepare('DELETE FROM simulation_robustness_analyses WHERE id = ? AND simulation_run_id = ?')
      .run(analysisId, runId).changes === 1
  );
}
