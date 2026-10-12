/**
 * Uncertainty analyses of completed backtests (pass 5). Additive only: a new table; earlier
 * migrations are never edited.
 *
 * - Only COMPLETED analyses are stored: the whole result is computed first and written as one
 *   row, so a failed or interrupted analysis leaves nothing behind. status exists to make
 *   that explicit and is constrained to 'completed'.
 * - An analysis may only be attached to a completed run, and must carry that run's dataset
 *   fingerprint (the sample it resampled is exactly the run's eligible dataset).
 * - Rows cannot be updated (a trigger refuses UPDATE). They can be deleted, which leaves no
 *   other record inconsistent; deleting a run cascades to its analyses.
 * - The seed, algorithm version, configuration snapshot and fingerprint make every row
 *   reproducible; per-path results are not stored (only aggregates), bounding row size.
 */
export const sql = `
CREATE TABLE simulation_analyses (
  id                 INTEGER PRIMARY KEY AUTOINCREMENT,
  simulation_run_id  INTEGER NOT NULL REFERENCES simulation_runs (id) ON DELETE CASCADE,
  status             TEXT    NOT NULL CHECK (status = 'completed'),
  method             TEXT    NOT NULL CHECK (method = 'iid_bootstrap'),
  algorithm_version  TEXT    NOT NULL CHECK (length(algorithm_version) BETWEEN 1 AND 100),
  seed               INTEGER NOT NULL CHECK (seed BETWEEN 0 AND 9007199254740991),
  paths              INTEGER NOT NULL CHECK (paths BETWEEN 1 AND 1000000),
  sample_size        INTEGER NOT NULL CHECK (sample_size >= 1),
  dataset_sha256     TEXT    NOT NULL
                     CHECK (length(dataset_sha256) = 64 AND dataset_sha256 NOT GLOB '*[^0-9a-f]*'),
  config_json        TEXT    NOT NULL CHECK (json_valid(config_json)),
  summary_json       TEXT    NOT NULL CHECK (json_valid(summary_json)),
  created_at         TEXT    NOT NULL,
  completed_at       TEXT    NOT NULL
);
CREATE INDEX idx_simulation_analyses_run ON simulation_analyses (simulation_run_id, id);

CREATE TRIGGER simulation_analyses_completed_run_only
BEFORE INSERT ON simulation_analyses
WHEN NOT EXISTS (
  SELECT 1 FROM simulation_runs
   WHERE id = NEW.simulation_run_id
     AND status = 'completed'
     AND dataset_sha256 = NEW.dataset_sha256)
BEGIN
  SELECT RAISE(ABORT, 'an analysis must belong to a completed run with the same dataset fingerprint');
END;

CREATE TRIGGER simulation_analyses_immutable
BEFORE UPDATE ON simulation_analyses
BEGIN
  SELECT RAISE(ABORT, 'simulation analyses are immutable');
END;
`;
