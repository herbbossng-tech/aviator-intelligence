import { mkdirSync } from 'node:fs';
import path from 'node:path';
import Database from 'better-sqlite3';

export type Db = Database.Database;

/** Opens (creating if needed) a SQLite database with the pragmas this app relies on. */
export function openDatabase(dbPath: string): Db {
  if (dbPath !== ':memory:') {
    mkdirSync(path.dirname(dbPath), { recursive: true });
  }
  const db = new Database(dbPath);
  db.pragma('foreign_keys = ON');
  db.pragma('busy_timeout = 5000');
  if (dbPath !== ':memory:') {
    db.pragma('journal_mode = WAL');
  }
  if (db.pragma('foreign_keys', { simple: true }) !== 1) {
    db.close();
    throw new Error('SQLite foreign key enforcement could not be enabled');
  }
  return db;
}
