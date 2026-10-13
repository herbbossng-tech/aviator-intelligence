/**
 * Staking progressions in backtests. Additive only: earlier migrations are never edited, and
 * no existing row is changed (every new column is NULL for older runs and ledger rows, which
 * keep meaning "flat stakes").
 *
 * - simulation_runs.staking_json: the staking plan a run used (NULL = flat stakes). It cannot
 *   be changed once written.
 * - ledger_entries progression columns, set only for a leg staked by a progression:
 *   progression_step (zero-based), requested_stake_minor (what the progression asked for;
 *   stake_minor stays the stake actually placed), cycle_loss_before/after_minor,
 *   skip_reason (why nothing was placed) and progression_active (0 once a permanent limit has
 *   made the leg inactive).
 * - A trigger keeps those columns consistent with each other and with the entry's result, and
 *   allows them only on runs that have a staking plan.
 */
export const sql = `
ALTER TABLE simulation_runs ADD COLUMN staking_json TEXT
  CHECK (staking_json IS NULL OR json_valid(staking_json));

ALTER TABLE ledger_entries ADD COLUMN progression_step INTEGER
  CHECK (progression_step IS NULL OR progression_step BETWEEN 0 AND 1000);
ALTER TABLE ledger_entries ADD COLUMN requested_stake_minor INTEGER
  CHECK (requested_stake_minor IS NULL OR requested_stake_minor > 0);
ALTER TABLE ledger_entries ADD COLUMN cycle_loss_before_minor INTEGER
  CHECK (cycle_loss_before_minor IS NULL OR cycle_loss_before_minor >= 0);
ALTER TABLE ledger_entries ADD COLUMN cycle_loss_after_minor INTEGER
  CHECK (cycle_loss_after_minor IS NULL OR cycle_loss_after_minor >= 0);
ALTER TABLE ledger_entries ADD COLUMN skip_reason TEXT
  CHECK (skip_reason IS NULL OR skip_reason IN ('insufficient_bankroll', 'max_steps_reached',
    'max_stake_exceeded', 'cycle_exposure_exceeded', 'sequence_exhausted'));
ALTER TABLE ledger_entries ADD COLUMN progression_active INTEGER
  CHECK (progression_active IS NULL OR progression_active IN (0, 1));

CREATE TRIGGER simulation_runs_staking_final
BEFORE UPDATE OF staking_json ON simulation_runs
BEGIN
  SELECT RAISE(ABORT, 'a simulation run''s staking plan cannot be changed');
END;

CREATE TRIGGER ledger_entries_progression_consistent
BEFORE INSERT ON ledger_entries
WHEN (NEW.progression_step IS NOT NULL OR NEW.requested_stake_minor IS NOT NULL
      OR NEW.cycle_loss_before_minor IS NOT NULL OR NEW.cycle_loss_after_minor IS NOT NULL
      OR NEW.skip_reason IS NOT NULL OR NEW.progression_active IS NOT NULL)
  AND (NEW.progression_step IS NULL OR NEW.cycle_loss_before_minor IS NULL
       OR NEW.cycle_loss_after_minor IS NULL OR NEW.progression_active IS NULL
       OR (SELECT staking_json FROM simulation_runs WHERE id = NEW.simulation_run_id) IS NULL
       OR ((NEW.result = 'skipped') <> (NEW.skip_reason IS NOT NULL))
       OR (NEW.result <> 'skipped' AND (NEW.requested_stake_minor IS NOT NEW.stake_minor
                                        OR NEW.progression_active <> 1))
       OR (NEW.result = 'skipped' AND NEW.cycle_loss_after_minor <> NEW.cycle_loss_before_minor)
       OR (NEW.result = 'win' AND NEW.cycle_loss_after_minor <> 0)
       OR (NEW.result = 'loss'
           AND NEW.cycle_loss_after_minor <> NEW.cycle_loss_before_minor + NEW.stake_minor)
       OR (NEW.skip_reason = 'insufficient_bankroll'
           AND (NEW.requested_stake_minor IS NULL OR NEW.progression_active <> 1))
       OR (NEW.skip_reason IS NOT NULL AND NEW.skip_reason <> 'insufficient_bankroll'
           AND NEW.progression_active <> 0))
BEGIN
  SELECT RAISE(ABORT, 'ledger progression fields are inconsistent');
END;
`;
