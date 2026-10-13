import { mkdtempSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { openDatabase, type Db } from '../src/db/connection.js';
import { getSchemaVersion, migrate } from '../src/db/migrate.js';
import { MIGRATIONS } from '../src/db/migrations/index.js';
import { insertRound, listRounds } from '../src/db/repositories/rounds.js';
import { getOverview } from '../src/db/repositories/overview.js';
import { roundsQuerySchema } from '@aviator/shared';
import { createTestDb, SYNTHETIC_SOURCE } from './helpers.js';

const pageOf = (limit: number, offset: number) => roundsQuerySchema.parse({ limit, offset });

const NOW = '2026-01-01T00:00:00.000Z';
const dbs: Db[] = [];
function freshDb(): Db {
  const db = createTestDb();
  dbs.push(db);
  return db;
}
afterEach(() => {
  while (dbs.length) dbs.pop()?.close();
});

function syntheticRound(overrides: Partial<Parameters<typeof insertRound>[1]> = {}) {
  return {
    multiplierX100: 150,
    source: SYNTHETIC_SOURCE,
    sourceRoundId: null,
    observedAt: NOW,
    eventAt: null,
    importId: null,
    isSynthetic: true,
    ...overrides,
  };
}

const COMPLETED_SUMMARY = {
  summary_json: '{}',
  stop_reason: 'completed_all_rounds',
  dataset_sha256: 'a'.repeat(64),
};

function insertRun(db: Db, extra: Record<string, unknown> = {}) {
  const columns = {
    strategy_snapshot_json: '{}',
    settings_json: '{}',
    dataset_json: '{}',
    currency: 'NGN',
    starting_bankroll_minor: 100_000,
    ...extra,
  };
  const keys = Object.keys(columns);
  return db
    .prepare(
      `INSERT INTO simulation_runs (${keys.join(', ')}) VALUES (${keys.map(() => '?').join(', ')})`,
    )
    .run(...Object.values(columns));
}

describe('database initialisation', () => {
  it('creates the schema and records the migration version', () => {
    const db = freshDb();
    expect(getSchemaVersion(db)).toBe(MIGRATIONS.length);
    const tables = db
      .prepare(
        `SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%' ORDER BY name`,
      )
      .all()
      .map((r) => (r as { name: string }).name);
    expect(tables).toEqual([
      'data_imports',
      'ledger_entries',
      'rounds',
      'schema_migrations',
      'simulation_analyses',
      'simulation_block_bootstrap_analyses',
      'simulation_robustness_analyses',
      'simulation_runs',
      'strategies',
    ]);
    expect(db.pragma('foreign_keys', { simple: true })).toBe(1);
  });

  it('is idempotent when migrations are run again', () => {
    const db = freshDb();
    expect(migrate(db).applied).toEqual([]);
  });

  it('creates a file database (and its directory) on disk', () => {
    const dir = mkdtempSync(path.join(os.tmpdir(), 'aviator-db-test-'));
    try {
      const file = path.join(dir, 'nested', 'test.sqlite');
      const db = openDatabase(file);
      migrate(db);
      expect(db.pragma('journal_mode', { simple: true })).toBe('wal');
      db.close();
      const reopened = openDatabase(file);
      expect(getSchemaVersion(reopened)).toBe(MIGRATIONS.length);
      reopened.close();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('rolls back a failing migration completely', () => {
    const db = openDatabase(':memory:');
    dbs.push(db);
    const broken = [
      ...MIGRATIONS,
      {
        version: MIGRATIONS.length + 1,
        name: 'broken',
        sql: 'CREATE TABLE half_done (id INTEGER); SELECT * FROM missing_table;',
      },
    ];
    expect(() => migrate(db, broken)).toThrow();
    expect(getSchemaVersion(db)).toBe(MIGRATIONS.length);
    expect(
      db.prepare(`SELECT name FROM sqlite_master WHERE name = 'half_done'`).get(),
    ).toBeUndefined();
  });

  it('refuses a database newer than the application', () => {
    const db = freshDb();
    db.prepare('INSERT INTO schema_migrations (version, name) VALUES (?, ?)').run(999, 'future');
    expect(() => migrate(db)).toThrow(/newer than this application/);
  });
});

describe('schema constraints', () => {
  it('rejects multipliers below 1.00x and non-integer values', () => {
    const db = freshDb();
    expect(() => insertRound(db, syntheticRound({ multiplierX100: 99 }))).toThrow(/CHECK/);
    expect(() =>
      db
        .prepare(`INSERT INTO rounds (multiplier_x100, source, observed_at) VALUES ('abc', 's', ?)`)
        .run(NOW),
    ).toThrow();
  });

  it('enforces uniqueness of (source, source_round_id) but allows missing source ids', () => {
    const db = freshDb();
    insertRound(db, syntheticRound({ sourceRoundId: 'r-1' }));
    expect(() => insertRound(db, syntheticRound({ sourceRoundId: 'r-1' }))).toThrow(/UNIQUE/);
    insertRound(db, syntheticRound());
    insertRound(db, syntheticRound());
  });

  it('enforces foreign keys', () => {
    const db = freshDb();
    expect(() => insertRound(db, syntheticRound({ importId: 12345 }))).toThrow(/FOREIGN KEY/);
  });

  it('only allows summary fields on completed simulation runs', () => {
    const db = freshDb();
    expect(() => insertRun(db, { status: 'pending', ending_bankroll_minor: 5 })).toThrow(/CHECK/);
    expect(() => insertRun(db, { status: 'completed' })).toThrow(/CHECK|summary is inconsistent/);
    const completed = {
      status: 'completed',
      ending_bankroll_minor: 90_000,
      rounds_processed: 10,
      completed_at: NOW,
    };
    // Migration 003: a completed run must also carry a summary, stop reason and dataset hash.
    expect(() => insertRun(db, completed)).toThrow(/summary is inconsistent/);
    expect(() =>
      insertRun(db, { status: 'failed', summary_json: '{}', stop_reason: 'max_rounds' }),
    ).toThrow(/summary is inconsistent/);
    expect(() =>
      insertRun(db, { ...COMPLETED_SUMMARY, ...completed, stop_reason: 'lucky_streak' }),
    ).toThrow(/CHECK/);
    expect(() =>
      insertRun(db, { ...COMPLETED_SUMMARY, ...completed, dataset_sha256: 'not-a-hash' }),
    ).toThrow(/CHECK/);
    insertRun(db, { ...COMPLETED_SUMMARY, ...completed });
  });

  it('only allows ledger entries on completed simulation runs', () => {
    const db = freshDb();
    const failed = insertRun(db, { status: 'failed' }).lastInsertRowid;
    expect(() =>
      db
        .prepare(
          `INSERT INTO ledger_entries (simulation_run_id, sequence_no, leg_key, stake_minor, cashout_target_x100, gross_return_minor, net_minor, result)
           VALUES (?, 0, 'A', 500, 200, 0, -500, 'loss')`,
        )
        .run(failed),
    ).toThrow(/completed simulation run/);
  });

  it('keeps ledger arithmetic consistent', () => {
    const db = freshDb();
    const runId = insertRun(db, {
      ...COMPLETED_SUMMARY,
      status: 'completed',
      ending_bankroll_minor: 100_000,
      rounds_processed: 1,
      completed_at: NOW,
    }).lastInsertRowid;
    const insert = db.prepare(
      `INSERT INTO ledger_entries (simulation_run_id, sequence_no, leg_key, stake_minor, cashout_target_x100, gross_return_minor, net_minor, result)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    );
    insert.run(runId, 0, 'A', 500, 200, 1000, 500, 'win');
    expect(() => insert.run(runId, 1, 'A', 500, 200, 1000, 400, 'win')).toThrow(/CHECK/); // net mismatch
    expect(() => insert.run(runId, 1, 'C', 500, 200, 1000, 500, 'win')).toThrow(/CHECK/); // unknown leg
    expect(() => insert.run(runId, 1, 'A', 500, 200, 100, -400, 'loss')).toThrow(/CHECK/); // loss with return
    expect(() => insert.run(runId, 0, 'A', 500, 200, 1000, 500, 'win')).toThrow(/UNIQUE/); // duplicate slot
    // A missing run is rejected (by the completed-run trigger, which fires before the FK check).
    expect(() => insert.run(9999, 0, 'A', 500, 200, 1000, 500, 'win')).toThrow(
      /completed simulation run|FOREIGN KEY/,
    );
  });
});

describe('repositories', () => {
  it('returns an honest empty overview for an empty database', () => {
    const db = freshDb();
    expect(getOverview(db, 'NGN')).toEqual({
      currency: 'NGN',
      rounds: { total: 0, distinctSources: 0, latestObservedAt: null },
      imports: { total: 0, failed: 0, recordsAccepted: 0, recordsRejected: 0, recordsDuplicate: 0 },
      strategies: { total: 0 },
      simulations: { total: 0, completed: 0 },
      latestVirtualBankroll: null,
    });
  });

  it('excludes synthetic fixtures from listings and aggregates', () => {
    const db = freshDb();
    insertRound(db, syntheticRound());
    expect(listRounds(db, pageOf(10, 0))).toEqual({ items: [], total: 0 });
    expect(getOverview(db, 'NGN').rounds.total).toBe(0);
  });

  it('lists non-synthetic rounds newest first with pagination', () => {
    const db = freshDb();
    // Flagged non-synthetic only to exercise the read path; the values are arbitrary test inputs.
    insertRound(
      db,
      syntheticRound({
        isSynthetic: false,
        observedAt: '2026-01-01T00:00:00.000Z',
        multiplierX100: 120,
      }),
    );
    insertRound(
      db,
      syntheticRound({
        isSynthetic: false,
        observedAt: '2026-01-02T00:00:00.000Z',
        multiplierX100: 340,
      }),
    );
    const page = listRounds(db, pageOf(1, 0));
    expect(page.total).toBe(2);
    expect(page.items).toHaveLength(1);
    expect(page.items[0]?.multiplierX100).toBe(340);
    expect(listRounds(db, pageOf(1, 1)).items[0]?.multiplierX100).toBe(120);
  });
});
