import {
  bootstrapSummarySchema,
  resolvedDatasetSchema,
  simulationSettingsSchema,
  stakingIdentity,
  stakingPlanSchema,
  twoLegStrategyConfigSchema,
  type BootstrapSummary,
  type SimulationAnalysisDto,
  type SimulationRunDto,
} from '@aviator/shared';
import { z } from 'zod';
import type { Db } from '../connection.js';
import { StoredDataError } from '../storedDataError.js';

export interface NewAnalysis {
  run: SimulationRunDto;
  datasetSha256: string;
  summary: BootstrapSummary;
  createdAt: string;
  completedAt: string;
}

/**
 * The configuration an analysis replayed. The staking plan is recorded only for runs that
 * have one, so snapshots of flat-stake runs are written exactly as before.
 */
export function configSnapshot(run: SimulationRunDto) {
  return {
    strategy: run.strategy,
    settings: run.settings,
    datasetRequest: run.datasetRequest,
    ...(run.staking === null ? {} : { staking: run.staking }),
  };
}

/** Inserts one completed analysis as a single row (atomic). */
export function insertAnalysis(db: Db, a: NewAnalysis): number {
  return Number(
    db
      .prepare(
        `INSERT INTO simulation_analyses (
           simulation_run_id, status, method, algorithm_version, seed, paths, sample_size,
           dataset_sha256, config_json, summary_json, created_at, completed_at)
         VALUES (?, 'completed', 'iid_bootstrap', ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        a.run.id,
        a.summary.algorithmVersion,
        a.summary.seed,
        a.summary.paths,
        a.summary.sample.size,
        a.datasetSha256,
        JSON.stringify(configSnapshot(a.run)),
        JSON.stringify(a.summary),
        a.createdAt,
        a.completedAt,
      ).lastInsertRowid,
  );
}

interface AnalysisRow {
  id: number;
  simulation_run_id: number;
  algorithm_version: string;
  seed: number;
  paths: number;
  dataset_sha256: string;
  config_json: string;
  summary_json: string;
  created_at: string;
  completed_at: string;
}

const COLUMNS =
  'id, simulation_run_id, algorithm_version, seed, paths, dataset_sha256, config_json, summary_json, created_at, completed_at';

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
 * Every stored row is checked on read against its run: the configuration snapshot (strategy,
 * settings, dataset selection and staking plan) must equal the run's, the fingerprint must
 * match, and the summary's staking metadata must identify exactly the run's progressions
 * (and be absent for a flat-stake run). A row that fails is reported (StoredDataError, HTTP
 * 500), never repaired or skipped.
 */
function toDto(row: AnalysisRow, run: SimulationRunDto): SimulationAnalysisDto {
  try {
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
    const summary = bootstrapSummarySchema.parse(JSON.parse(row.summary_json));
    if (summary.seed !== row.seed || summary.paths !== row.paths) {
      throw new Error('the seed or path count columns differ from the summary');
    }
    if ((summary.staking === undefined) !== (run.staking === null)) {
      throw new Error("the summary's staking metadata does not match the run's plan");
    }
    if (summary.staking !== undefined && run.staking !== null) {
      const identity = stakingIdentity(run.staking);
      for (const key of ['A', 'B'] as const) {
        const leg = summary.staking.legs[key];
        const id = identity[key];
        if (
          leg === null || id === null
            ? leg !== id
            : leg.mode !== id.mode ||
              leg.configKey !== id.configKey ||
              leg.denominator !== summary.paths ||
              leg.pathsStoppedByLimit > summary.paths ||
              leg.pathsWithBankrollSkips > summary.paths
        ) {
          throw new Error("the summary's staking metadata does not match the run's plan");
        }
      }
    }
    return {
      id: row.id,
      simulationRunId: row.simulation_run_id,
      status: 'completed',
      createdAt: row.created_at,
      completedAt: row.completed_at,
      algorithmVersion: row.algorithm_version,
      seed: row.seed,
      paths: row.paths,
      datasetSha256: row.dataset_sha256,
      summary,
    };
  } catch (error) {
    throw new StoredDataError(
      { simulationRunId: row.simulation_run_id, simulationAnalysisId: row.id },
      error,
    );
  }
}

export function listAnalyses(
  db: Db,
  run: SimulationRunDto,
  { limit, offset }: { limit: number; offset: number },
): { items: SimulationAnalysisDto[]; total: number } {
  const runId = run.id;
  const rows = db
    .prepare(
      `SELECT ${COLUMNS} FROM simulation_analyses WHERE simulation_run_id = ?
        ORDER BY id DESC LIMIT ? OFFSET ?`,
    )
    .all(runId, limit, offset) as AnalysisRow[];
  const { total } = db
    .prepare('SELECT COUNT(*) AS total FROM simulation_analyses WHERE simulation_run_id = ?')
    .get(runId) as { total: number };
  return { items: rows.map((row) => toDto(row, run)), total };
}

export function getAnalysis(
  db: Db,
  run: SimulationRunDto,
  analysisId: number,
): SimulationAnalysisDto | null {
  const runId = run.id;
  const row = db
    .prepare(`SELECT ${COLUMNS} FROM simulation_analyses WHERE id = ? AND simulation_run_id = ?`)
    .get(analysisId, runId) as AnalysisRow | undefined;
  return row ? toDto(row, run) : null;
}
