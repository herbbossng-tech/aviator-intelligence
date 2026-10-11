/**
 * Initial schema. Conventions:
 * - Money: INTEGER minor units (*_minor). Multipliers: INTEGER x100 (*_x100).
 * - Timestamps: TEXT, ISO-8601 UTC (e.g. 2026-01-31T12:00:00.000Z).
 * - JSON columns are validated by the application (Zod) and by json_valid().
 */
export const sql = `
CREATE TABLE data_imports (
  id                  INTEGER PRIMARY KEY AUTOINCREMENT,
  source_description  TEXT    NOT NULL CHECK (length(trim(source_description)) > 0),
  source_kind         TEXT    NOT NULL CHECK (source_kind IN ('manual_entry', 'file_import')),
  status              TEXT    NOT NULL CHECK (status IN ('pending', 'completed', 'completed_with_rejections', 'failed')),
  records_total       INTEGER NOT NULL DEFAULT 0 CHECK (records_total >= 0),
  records_accepted    INTEGER NOT NULL DEFAULT 0 CHECK (records_accepted >= 0),
  records_rejected    INTEGER NOT NULL DEFAULT 0 CHECK (records_rejected >= 0),
  error_summary       TEXT,
  imported_at         TEXT    NOT NULL,
  created_at          TEXT    NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  CHECK (records_accepted + records_rejected <= records_total)
);

CREATE TABLE rounds (
  id               INTEGER PRIMARY KEY AUTOINCREMENT,
  multiplier_x100  INTEGER NOT NULL CHECK (multiplier_x100 BETWEEN 100 AND 100000000),
  source           TEXT    NOT NULL CHECK (length(trim(source)) > 0),
  source_round_id  TEXT    CHECK (source_round_id IS NULL OR length(trim(source_round_id)) > 0),
  observed_at      TEXT    NOT NULL,
  event_at         TEXT,
  import_id        INTEGER REFERENCES data_imports (id) ON DELETE RESTRICT,
  is_synthetic     INTEGER NOT NULL DEFAULT 0 CHECK (is_synthetic IN (0, 1)),
  created_at       TEXT    NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  UNIQUE (source, source_round_id)
);
CREATE INDEX idx_rounds_observed_at ON rounds (observed_at);
CREATE INDEX idx_rounds_import_id ON rounds (import_id);

CREATE TABLE strategies (
  id           INTEGER PRIMARY KEY AUTOINCREMENT,
  name         TEXT NOT NULL UNIQUE CHECK (length(trim(name)) > 0),
  description  TEXT NOT NULL DEFAULT '',
  config_json  TEXT NOT NULL CHECK (json_valid(config_json)),
  created_at   TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  updated_at   TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
);

CREATE TABLE simulation_runs (
  id                       INTEGER PRIMARY KEY AUTOINCREMENT,
  strategy_id              INTEGER REFERENCES strategies (id) ON DELETE SET NULL,
  strategy_snapshot_json   TEXT    NOT NULL CHECK (json_valid(strategy_snapshot_json)),
  settings_json            TEXT    NOT NULL CHECK (json_valid(settings_json)),
  dataset_json             TEXT    NOT NULL CHECK (json_valid(dataset_json)),
  currency                 TEXT    NOT NULL CHECK (currency IN ('NGN', 'USD', 'GBP', 'EUR')),
  starting_bankroll_minor  INTEGER NOT NULL CHECK (starting_bankroll_minor > 0),
  random_seed              INTEGER,
  status                   TEXT    NOT NULL DEFAULT 'pending'
                           CHECK (status IN ('pending', 'running', 'completed', 'failed', 'cancelled')),
  error_message            TEXT,
  ending_bankroll_minor    INTEGER CHECK (ending_bankroll_minor IS NULL OR ending_bankroll_minor >= 0),
  rounds_processed         INTEGER CHECK (rounds_processed IS NULL OR rounds_processed >= 0),
  created_at               TEXT    NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  started_at               TEXT,
  completed_at             TEXT,
  -- Summary fields may only be populated once a run has actually completed.
  CHECK (status = 'completed' OR (ending_bankroll_minor IS NULL AND rounds_processed IS NULL)),
  CHECK (status <> 'completed' OR (ending_bankroll_minor IS NOT NULL AND rounds_processed IS NOT NULL AND completed_at IS NOT NULL))
);
CREATE INDEX idx_simulation_runs_strategy_id ON simulation_runs (strategy_id);
CREATE INDEX idx_simulation_runs_status ON simulation_runs (status);

CREATE TABLE ledger_entries (
  id                    INTEGER PRIMARY KEY AUTOINCREMENT,
  simulation_run_id     INTEGER NOT NULL REFERENCES simulation_runs (id) ON DELETE CASCADE,
  round_id              INTEGER REFERENCES rounds (id) ON DELETE RESTRICT,
  sequence_no           INTEGER NOT NULL CHECK (sequence_no >= 0),
  leg_key               TEXT    NOT NULL CHECK (leg_key IN ('A', 'B')),
  stake_minor           INTEGER NOT NULL CHECK (stake_minor >= 0),
  cashout_target_x100   INTEGER NOT NULL CHECK (cashout_target_x100 BETWEEN 101 AND 100000000),
  gross_return_minor    INTEGER NOT NULL CHECK (gross_return_minor >= 0),
  net_minor             INTEGER NOT NULL,
  result                TEXT    NOT NULL CHECK (result IN ('win', 'loss', 'skipped')),
  bankroll_after_minor  INTEGER CHECK (bankroll_after_minor IS NULL OR bankroll_after_minor >= 0),
  created_at            TEXT    NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  CHECK (net_minor = gross_return_minor - stake_minor),
  CHECK (result <> 'skipped' OR (stake_minor = 0 AND gross_return_minor = 0)),
  CHECK (result <> 'loss' OR gross_return_minor = 0),
  UNIQUE (simulation_run_id, sequence_no, leg_key)
);
CREATE INDEX idx_ledger_entries_round_id ON ledger_entries (round_id);
`;
