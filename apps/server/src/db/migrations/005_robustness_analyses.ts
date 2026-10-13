/**
 * Chronological robustness analyses of completed backtests (pass 6). Additive only: a new
 * table; earlier migrations are never edited.
 *
 * - Only COMPLETED analyses are stored: the whole result is computed and verified first, then
 *   written as one row, so a failed or interrupted analysis leaves nothing behind.
 * - An analysis may only be attached to a completed run, and must carry that run's dataset
 *   fingerprint (it replayed exactly the run's eligible dataset).
 * - algorithm_version and result_schema_version identify how the result was computed and how
 *   result_json is laid out; the application refuses versions it does not know.
 * - config_json snapshots the strategy, settings and dataset selection the result used.
 * - Rows cannot be updated (a trigger refuses UPDATE). They can be deleted, which leaves no
 *   other record inconsistent; deleting a run cascades to its robustness analyses.
 */
export const sql = `
CREATE TABLE simulation_robustness_analyses (
  id                     INTEGER PRIMARY KEY AUTOINCREMENT,
  simulation_run_id      INTEGER NOT NULL REFERENCES simulation_runs (id) ON DELETE CASCADE,
  status                 TEXT    NOT NULL CHECK (status = 'completed'),
  method                 TEXT    NOT NULL CHECK (method = 'chronological_blocks'),
  algorithm_version      TEXT    NOT NULL CHECK (length(algorithm_version) BETWEEN 1 AND 100),
  result_schema_version  INTEGER NOT NULL CHECK (result_schema_version >= 1),
  windows                INTEGER NOT NULL CHECK (windows BETWEEN 2 AND 10),
  sample_size            INTEGER NOT NULL CHECK (sample_size >= windows * 30),
  dataset_sha256         TEXT    NOT NULL
                         CHECK (length(dataset_sha256) = 64 AND dataset_sha256 NOT GLOB '*[^0-9a-f]*'),
  config_json            TEXT    NOT NULL CHECK (json_valid(config_json)),
  result_json            TEXT    NOT NULL CHECK (json_valid(result_json)),
  created_at             TEXT    NOT NULL,
  completed_at           TEXT    NOT NULL
);
CREATE INDEX idx_simulation_robustness_analyses_run
  ON simulation_robustness_analyses (simulation_run_id, id);

CREATE TRIGGER simulation_robustness_analyses_completed_run_only
BEFORE INSERT ON simulation_robustness_analyses
WHEN NOT EXISTS (
  SELECT 1 FROM simulation_runs
   WHERE id = NEW.simulation_run_id
     AND status = 'completed'
     AND dataset_sha256 = NEW.dataset_sha256)
BEGIN
  SELECT RAISE(ABORT, 'a robustness analysis must belong to a completed run with the same dataset fingerprint');
END;

CREATE TRIGGER simulation_robustness_analyses_no_update
BEFORE UPDATE ON simulation_robustness_analyses
BEGIN
  SELECT RAISE(ABORT, 'robustness analyses cannot be updated');
END;
`;
