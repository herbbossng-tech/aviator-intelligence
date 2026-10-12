import {
  bootstrapSummarySchema,
  type BootstrapSummary,
  type SimulationAnalysisDto,
  type SimulationRunDto,
} from '@aviator/shared';
import type { Db } from '../connection.js';
import { StoredDataError } from '../storedDataError.js';

export interface NewAnalysis {
  run: SimulationRunDto;
  datasetSha256: string;
  summary: BootstrapSummary;
  createdAt: string;
  completedAt: string;
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
        JSON.stringify({
          strategy: a.run.strategy,
          settings: a.run.settings,
          datasetRequest: a.run.datasetRequest,
        }),
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
  summary_json: string;
  created_at: string;
  completed_at: string;
}

const COLUMNS =
  'id, simulation_run_id, algorithm_version, seed, paths, dataset_sha256, summary_json, created_at, completed_at';

function toDto(row: AnalysisRow): SimulationAnalysisDto {
  try {
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
      summary: bootstrapSummarySchema.parse(JSON.parse(row.summary_json)),
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
  runId: number,
  { limit, offset }: { limit: number; offset: number },
): { items: SimulationAnalysisDto[]; total: number } {
  const rows = db
    .prepare(
      `SELECT ${COLUMNS} FROM simulation_analyses WHERE simulation_run_id = ?
        ORDER BY id DESC LIMIT ? OFFSET ?`,
    )
    .all(runId, limit, offset) as AnalysisRow[];
  const { total } = db
    .prepare('SELECT COUNT(*) AS total FROM simulation_analyses WHERE simulation_run_id = ?')
    .get(runId) as { total: number };
  return { items: rows.map(toDto), total };
}

export function getAnalysis(
  db: Db,
  runId: number,
  analysisId: number,
): SimulationAnalysisDto | null {
  const row = db
    .prepare(`SELECT ${COLUMNS} FROM simulation_analyses WHERE id = ? AND simulation_run_id = ?`)
    .get(analysisId, runId) as AnalysisRow | undefined;
  return row ? toDto(row) : null;
}
