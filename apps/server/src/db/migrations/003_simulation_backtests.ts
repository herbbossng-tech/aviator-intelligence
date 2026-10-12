/**
 * Virtual backtests (pass 4). Additive only: migrations 001 and 002 are never edited.
 *
 * - simulation_runs gains the run summary (JSON), the stop reason and a SHA-256 of the
 *   ordered round list that was replayed (reproducibility check).
 * - ledger_entries gains the round's multiplier and the bankroll before the round, so the
 *   ledger can be read without joining back to rounds.
 * - Triggers keep summaries consistent with status: only a completed run may (and must)
 *   carry a summary, a stop reason and a dataset hash. Table CHECKs cannot be added to an
 *   existing table in SQLite without rebuilding it.
 * - Ledger rows may only be attached to a completed run, so a failed run never has a ledger.
 * - A stored ledger is immutable, and a completed run cannot later change status (which
 *   could otherwise leave a ledger behind a run that no longer claims to be completed).
 *   Deleting a run still cascades to its ledger.
 */
export const sql = `
ALTER TABLE simulation_runs ADD COLUMN summary_json TEXT
  CHECK (summary_json IS NULL OR json_valid(summary_json));
ALTER TABLE simulation_runs ADD COLUMN stop_reason TEXT
  CHECK (stop_reason IS NULL OR stop_reason IN ('completed_all_rounds', 'bankroll_exhausted',
    'insufficient_bankroll', 'stop_below', 'stop_at_or_above', 'max_drawdown', 'max_rounds'));
ALTER TABLE simulation_runs ADD COLUMN dataset_sha256 TEXT
  CHECK (dataset_sha256 IS NULL OR (length(dataset_sha256) = 64 AND dataset_sha256 NOT GLOB '*[^0-9a-f]*'));

ALTER TABLE ledger_entries ADD COLUMN round_multiplier_x100 INTEGER
  CHECK (round_multiplier_x100 IS NULL OR round_multiplier_x100 BETWEEN 100 AND 100000000);
ALTER TABLE ledger_entries ADD COLUMN bankroll_before_minor INTEGER
  CHECK (bankroll_before_minor IS NULL OR bankroll_before_minor >= 0);

CREATE INDEX idx_simulation_runs_created_at ON simulation_runs (created_at);

CREATE TRIGGER simulation_runs_summary_insert
BEFORE INSERT ON simulation_runs
WHEN (NEW.status = 'completed'
      AND (NEW.summary_json IS NULL OR NEW.stop_reason IS NULL OR NEW.dataset_sha256 IS NULL))
  OR (NEW.status <> 'completed' AND (NEW.summary_json IS NOT NULL OR NEW.stop_reason IS NOT NULL))
BEGIN
  SELECT RAISE(ABORT, 'simulation_runs summary is inconsistent with status');
END;

CREATE TRIGGER simulation_runs_summary_update
BEFORE UPDATE ON simulation_runs
WHEN (NEW.status = 'completed'
      AND (NEW.summary_json IS NULL OR NEW.stop_reason IS NULL OR NEW.dataset_sha256 IS NULL))
  OR (NEW.status <> 'completed' AND (NEW.summary_json IS NOT NULL OR NEW.stop_reason IS NOT NULL))
BEGIN
  SELECT RAISE(ABORT, 'simulation_runs summary is inconsistent with status');
END;

CREATE TRIGGER ledger_entries_completed_run_only
BEFORE INSERT ON ledger_entries
WHEN (SELECT status FROM simulation_runs WHERE id = NEW.simulation_run_id) IS NOT 'completed'
BEGIN
  SELECT RAISE(ABORT, 'ledger entries may only belong to a completed simulation run');
END;

CREATE TRIGGER ledger_entries_immutable
BEFORE UPDATE ON ledger_entries
BEGIN
  SELECT RAISE(ABORT, 'ledger entries are immutable');
END;

CREATE TRIGGER simulation_runs_completed_is_final
BEFORE UPDATE OF status ON simulation_runs
WHEN OLD.status = 'completed' AND NEW.status <> 'completed'
BEGIN
  SELECT RAISE(ABORT, 'a completed simulation run cannot change status');
END;
`;
