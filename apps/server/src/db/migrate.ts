import type { Db } from './connection.js';
import { MIGRATIONS, type Migration } from './migrations/index.js';

export interface MigrationResult {
  applied: number[];
  currentVersion: number;
}

function ensureMigrationsTable(db: Db): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS schema_migrations (
      version     INTEGER PRIMARY KEY,
      name        TEXT NOT NULL,
      applied_at  TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
    )
  `);
}

export function getSchemaVersion(db: Db): number {
  ensureMigrationsTable(db);
  const row = db.prepare('SELECT MAX(version) AS version FROM schema_migrations').get() as {
    version: number | null;
  };
  return row.version ?? 0;
}

/**
 * Applies pending migrations in order. Each migration and its bookkeeping row are
 * committed in a single transaction, so a failed migration leaves no partial schema.
 */
export function migrate(db: Db, migrations: readonly Migration[] = MIGRATIONS): MigrationResult {
  migrations.forEach((m, index) => {
    if (m.version !== index + 1) {
      throw new Error(
        `Migration list is not contiguous at "${m.name}" (expected version ${index + 1})`,
      );
    }
  });
  const current = getSchemaVersion(db);
  if (current > migrations.length) {
    throw new Error(
      `Database schema version ${current} is newer than this application supports (${migrations.length})`,
    );
  }
  const record = db.prepare('INSERT INTO schema_migrations (version, name) VALUES (?, ?)');
  const applied: number[] = [];
  for (const migration of migrations.slice(current)) {
    db.transaction(() => {
      db.exec(migration.sql);
      record.run(migration.version, migration.name);
    })();
    applied.push(migration.version);
  }
  return { applied, currentVersion: getSchemaVersion(db) };
}
