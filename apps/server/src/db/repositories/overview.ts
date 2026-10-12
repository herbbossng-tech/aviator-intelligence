import type { CurrencyCode, OverviewResponse } from '@aviator/shared';
import { currencyCodeSchema } from '@aviator/shared';
import type { Db } from '../connection.js';

/** Aggregates real stored data only. Nothing here is estimated or filled with placeholders. */
export function getOverview(db: Db, currency: CurrencyCode): OverviewResponse {
  const rounds = db
    .prepare(
      `SELECT COUNT(*) AS total, COUNT(DISTINCT source) AS distinctSources, MAX(observed_at) AS latestObservedAt
         FROM rounds WHERE is_synthetic = 0`,
    )
    .get() as { total: number; distinctSources: number; latestObservedAt: string | null };

  const imports = db
    .prepare(
      `SELECT COUNT(*) AS total,
              COALESCE(SUM(status = 'failed'), 0) AS failed,
              COALESCE(SUM(records_accepted), 0) AS recordsAccepted,
              COALESCE(SUM(records_rejected), 0) AS recordsRejected,
              COALESCE(SUM(records_duplicate), 0) AS recordsDuplicate
         FROM data_imports`,
    )
    .get() as OverviewResponse['imports'];

  const strategies = db.prepare('SELECT COUNT(*) AS total FROM strategies').get() as {
    total: number;
  };

  const simulations = db
    .prepare(
      `SELECT COUNT(*) AS total, COALESCE(SUM(status = 'completed'), 0) AS completed FROM simulation_runs`,
    )
    .get() as { total: number; completed: number };

  const latest = db
    .prepare(
      `SELECT id, currency, starting_bankroll_minor, ending_bankroll_minor, completed_at
         FROM simulation_runs
        WHERE status = 'completed'
        ORDER BY completed_at DESC, id DESC
        LIMIT 1`,
    )
    .get() as
    | {
        id: number;
        currency: string;
        starting_bankroll_minor: number;
        ending_bankroll_minor: number;
        completed_at: string;
      }
    | undefined;

  return {
    currency,
    rounds,
    imports,
    strategies,
    simulations,
    latestVirtualBankroll: latest
      ? {
          simulationRunId: latest.id,
          currency: currencyCodeSchema.parse(latest.currency),
          startingBankrollMinor: latest.starting_bankroll_minor,
          endingBankrollMinor: latest.ending_bankroll_minor,
          completedAt: latest.completed_at,
        }
      : null,
  };
}
