import type { AddressInfo } from 'node:net';
import type { Server } from 'node:http';
import { runBacktest, type BacktestRequest } from '@aviator/shared';
import type { AppConfig } from '../src/config/env.js';
import { getDatasetReport, loadReplayRounds } from '../src/db/repositories/simulations.js';
import { hashReplayRounds } from '../src/simulations/service.js';
import { openDatabase, type Db } from '../src/db/connection.js';
import { migrate } from '../src/db/migrate.js';
import { createApp } from '../src/http/app.js';

export const TEST_CONFIG: AppConfig = {
  nodeEnv: 'test',
  host: '127.0.0.1',
  port: 0,
  dbPath: ':memory:',
  currency: 'NGN',
};

export function createTestDb(): Db {
  const db = openDatabase(':memory:');
  migrate(db);
  return db;
}

/** SYNTHETIC TEST FIXTURE: not real Aviator data. Always flagged is_synthetic = 1 unless overridden. */
export const SYNTHETIC_SOURCE = 'synthetic-test-fixture';

export async function startTestServer(db: Db, log: (m: string, e: unknown) => void = () => {}) {
  const app = createApp({ db, config: TEST_CONFIG, log });
  const server: Server = await new Promise((resolve) => {
    const s = app.listen(0, '127.0.0.1', () => resolve(s));
  });
  const { port } = server.address() as AddressInfo;
  return {
    baseUrl: `http://127.0.0.1:${port}`,
    close: () =>
      new Promise<void>((resolve, reject) => server.close((e) => (e ? reject(e) : resolve()))),
  };
}

/** Columns added by migration 006; NULL on every row written before it. */
export const MIGRATION_006_RUN_COLUMNS = ['staking_json'] as const;
export const MIGRATION_006_LEDGER_COLUMNS = [
  'progression_step',
  'requested_stake_minor',
  'cycle_loss_before_minor',
  'cycle_loss_after_minor',
  'skip_reason',
  'progression_active',
] as const;

/** Drops the given columns from each row (to compare rows written before a migration). */
export function withoutColumns(rows: unknown[], columns: readonly string[]): unknown[] {
  return rows.map((row) =>
    Object.fromEntries(
      Object.entries(row as Record<string, unknown>).filter(([k]) => !columns.includes(k)),
    ),
  );
}

/**
 * Writes a completed flat-stake run exactly as the application did before migration 006
 * (only the columns that existed then), for migration tests on older schemas.
 */
export function insertLegacyRun(db: Db, request: BacktestRequest): number {
  const report = getDatasetReport(db, request.dataset, 100_000);
  const rounds = loadReplayRounds(db, request.dataset);
  const result = runBacktest(rounds, request.strategy, request.settings);
  const { summary } = result;
  const at = '2026-01-01T00:00:00.000Z';
  const runId = Number(
    db
      .prepare(
        `INSERT INTO simulation_runs (
           strategy_snapshot_json, settings_json, dataset_json, currency, starting_bankroll_minor,
           status, ending_bankroll_minor, rounds_processed, created_at, started_at, completed_at,
           summary_json, stop_reason, dataset_sha256)
         VALUES (?, ?, ?, ?, ?, 'completed', ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        JSON.stringify(request.strategy),
        JSON.stringify(request.settings),
        JSON.stringify({ request: request.dataset, report }),
        summary.currency,
        summary.startingBankrollMinor,
        summary.endingBankrollMinor,
        summary.roundsReplayed,
        at,
        at,
        at,
        JSON.stringify(summary),
        summary.stopReason,
        hashReplayRounds(request.dataset.source, rounds),
      ).lastInsertRowid,
  );
  const insertEntry = db.prepare(
    `INSERT INTO ledger_entries (
       simulation_run_id, round_id, sequence_no, leg_key, stake_minor, cashout_target_x100,
       gross_return_minor, net_minor, result, bankroll_after_minor, created_at,
       round_multiplier_x100, bankroll_before_minor)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  );
  for (const round of result.rounds) {
    for (const leg of round.legs) {
      insertEntry.run(
        runId,
        round.roundId,
        round.sequenceNo,
        leg.leg,
        leg.stakeMinor,
        leg.cashoutTargetX100,
        leg.grossReturnMinor,
        leg.netMinor,
        leg.result,
        round.bankrollAfterMinor,
        at,
        round.multiplierX100,
        round.bankrollBeforeMinor,
      );
    }
  }
  return runId;
}
