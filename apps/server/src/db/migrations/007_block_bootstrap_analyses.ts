/**
 * Moving-block bootstrap analyses of completed backtests (progression increment 4, step 3).
 * Additive only: a new table; earlier migrations and their rows are never edited.
 *
 * A separate table is needed because simulation_analyses (migration 004) constrains its method
 * to 'iid_bootstrap'; changing that CHECK in SQLite would mean rebuilding the table, which
 * rewrites every existing IID analysis row. See docs/BLOCK_BOOTSTRAP_DESIGN.md §8.
 *
 * Conventions follow migration 004:
 * - Only COMPLETED analyses are stored: the whole result is computed first and written as one
 *   row, so a failed or interrupted analysis leaves nothing behind.
 * - An analysis may only be attached to a completed run and must carry that run's dataset
 *   fingerprint (the resampled sample is exactly the run's eligible dataset).
 * - Rows cannot be updated (a trigger refuses UPDATE). They can be deleted, which leaves no
 *   other record inconsistent; deleting a run cascades to its analyses.
 * - The seed, block length, algorithm version, configuration snapshot and fingerprint make
 *   every row reproducible; per-path results are not stored (only aggregates).
 */
export const sql = `
CREATE TABLE simulation_block_bootstrap_analyses (
  id                 INTEGER PRIMARY KEY AUTOINCREMENT,
  simulation_run_id  INTEGER NOT NULL REFERENCES simulation_runs (id) ON DELETE CASCADE,
  status             TEXT    NOT NULL CHECK (status = 'completed'),
  method             TEXT    NOT NULL CHECK (method = 'moving_block_bootstrap'),
  algorithm_version  TEXT    NOT NULL CHECK (length(algorithm_version) BETWEEN 1 AND 100),
  seed               INTEGER NOT NULL CHECK (seed BETWEEN 0 AND 9007199254740991),
  paths              INTEGER NOT NULL CHECK (paths BETWEEN 1 AND 1000000),
  sample_size        INTEGER NOT NULL CHECK (sample_size >= 20),
  block_length       INTEGER NOT NULL CHECK (block_length BETWEEN 2 AND 500),
  dataset_sha256     TEXT    NOT NULL
                     CHECK (length(dataset_sha256) = 64 AND dataset_sha256 NOT GLOB '*[^0-9a-f]*'),
  config_json        TEXT    NOT NULL CHECK (json_valid(config_json)),
  summary_json       TEXT    NOT NULL CHECK (json_valid(summary_json)),
  created_at         TEXT    NOT NULL,
  completed_at       TEXT    NOT NULL,
  CHECK (block_length * 10 <= sample_size)
);
CREATE INDEX idx_simulation_block_bootstrap_analyses_run
  ON simulation_block_bootstrap_analyses (simulation_run_id, id);

CREATE TRIGGER simulation_block_bootstrap_analyses_completed_run_only
BEFORE INSERT ON simulation_block_bootstrap_analyses
WHEN NOT EXISTS (
  SELECT 1 FROM simulation_runs
   WHERE id = NEW.simulation_run_id
     AND status = 'completed'
     AND dataset_sha256 = NEW.dataset_sha256)
BEGIN
  SELECT RAISE(ABORT, 'a block analysis must belong to a completed run with the same dataset fingerprint');
END;

CREATE TRIGGER simulation_block_bootstrap_analyses_immutable
BEFORE UPDATE ON simulation_block_bootstrap_analyses
BEGIN
  SELECT RAISE(ABORT, 'block bootstrap analyses are immutable');
END;
`;
