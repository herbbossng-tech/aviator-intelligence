import { afterEach, describe, expect, it } from 'vitest';
import { roundsQuerySchema } from '@aviator/shared';
import type { Db } from '../src/db/connection.js';
import { listImports } from '../src/db/repositories/imports.js';
import { insertRound, listRounds } from '../src/db/repositories/rounds.js';
import { HttpError } from '../src/http/errors.js';
import { PreviewStore } from '../src/imports/previewStore.js';
import { confirmImport, previewImport } from '../src/imports/service.js';
import { createTestDb } from './helpers.js';

// SYNTHETIC TEST FIXTURES: every file below is invented test input, not real Aviator history.
const SOURCE = 'synthetic-test-fixture';
const NOW = new Date('2026-06-01T12:00:00.000Z');
const silent = () => {};

const dbs: Db[] = [];
function setup() {
  const db = createTestDb();
  dbs.push(db);
  return { db, store: new PreviewStore() };
}
afterEach(() => {
  while (dbs.length) dbs.pop()?.close();
});

const allRounds = (db: Db) => listRounds(db, roundsQuerySchema.parse({ limit: 200 })).items;

function run(
  db: Db,
  store: PreviewStore,
  content: string,
  format: 'csv' | 'json' = 'csv',
  source = SOURCE,
) {
  const preview = previewImport(db, store, { format, source, content }, NOW);
  return {
    preview,
    confirm: () => confirmImport(db, store, preview.previewId, { now: NOW, log: silent }),
  };
}

function httpError(fn: () => unknown): HttpError {
  try {
    fn();
  } catch (error) {
    if (error instanceof HttpError) return error;
    throw error;
  }
  throw new Error('expected HttpError');
}

const VALID_CSV = [
  'multiplier,sourceRoundId,eventAt',
  '1.00,SYN-1,2026-01-01T00:00:00Z',
  '2.35,SYN-2,2026-01-01T00:00:15+00:00',
  '17.5,SYN-3,',
].join('\n');

describe('preview', () => {
  it('classifies records without writing anything', () => {
    const { db, store } = setup();
    const { preview } = run(db, store, VALID_CSV);
    expect(preview.counts).toEqual({
      total: 3,
      new: 3,
      invalid: 0,
      duplicateExisting: 0,
      duplicateInFile: 0,
      possibleDuplicates: 0,
    });
    expect(preview.rows.map((r) => r.multiplierX100)).toEqual([100, 235, 1750]);
    expect(preview.rows[1]?.eventAt).toBe('2026-01-01T00:00:15.000Z');
    expect(preview.alreadyImported).toBeNull();
    expect(preview.contentSha256).toMatch(/^[0-9a-f]{64}$/);
    expect(allRounds(db)).toHaveLength(0);
    expect(listImports(db, 10, 0).total).toBe(0);
  });

  it('reports invalid rows with codes and line numbers', () => {
    const { db, store } = setup();
    const csv = 'multiplier,eventAt\n0.5,\n2.345,\n,\n2,2026-01-01T00:00:00\n3\n1.5,\n';
    const { preview } = run(db, store, csv);
    expect(preview.counts.invalid).toBe(5);
    expect(preview.counts.new).toBe(1);
    expect(preview.issues.map((i) => [i.line, i.code])).toEqual([
      [2, 'invalid_multiplier'],
      [3, 'invalid_multiplier'],
      [4, 'missing_required_field'],
      [5, 'invalid_timestamp'],
      [6, 'invalid_record'],
    ]);
  });

  it('applies the in-file duplicate policy', () => {
    const { db, store } = setup();
    const csv = [
      'multiplier,sourceRoundId',
      '1.5,SAME', // kept
      '1.5,SAME', // identical repeat -> duplicate_in_file
      '2.0,CONFLICT',
      '3.0,CONFLICT', // conflicting repeat -> both rejected
    ].join('\n');
    const { preview } = run(db, store, csv);
    expect(preview.rows.map((r) => r.status)).toEqual([
      'new',
      'duplicate_in_file',
      'invalid',
      'invalid',
    ]);
    expect(preview.rows[2]?.issues[0]?.code).toBe('conflicting_duplicate_in_file');
  });

  it('never deduplicates rounds without a source ID but warns about identical time and multiplier', () => {
    const { db, store } = setup();
    const csv =
      'multiplier,eventAt\n1.5,2026-01-01T00:00:00Z\n1.5,2026-01-01T00:00:00Z\n1.5,\n1.5,\n';
    const { preview, confirm } = run(db, store, csv);
    expect(preview.counts.new).toBe(4);
    expect(preview.counts.possibleDuplicates).toBe(2);
    expect(confirm().import.recordsAccepted).toBe(4);
  });

  it('bounds rows and issues in the response', () => {
    const { db, store } = setup();
    const csv = `multiplier\n${'abc\n'.repeat(250)}`;
    const { preview } = run(db, store, csv);
    expect(preview.counts.invalid).toBe(250);
    expect(preview.rows).toHaveLength(100);
    expect(preview.rowsTruncated).toBe(true);
    expect(preview.issues).toHaveLength(200);
    expect(preview.issuesTruncated).toBe(true);
  });
});

describe('confirm', () => {
  it('stores accepted rounds and an accurate import record in one step', () => {
    const { db, store } = setup();
    const csv = `${VALID_CSV}\nnot-a-number,SYN-4,\n2.35,SYN-2,2026-01-01T00:00:15Z`;
    const result = run(db, store, csv).confirm();
    expect(result.import).toMatchObject({
      source: SOURCE,
      sourceKind: 'file_import',
      format: 'csv',
      status: 'completed_with_rejections',
      recordsTotal: 5,
      recordsAccepted: 3,
      recordsRejected: 1,
      recordsDuplicate: 1,
      errorSummary: null,
      importedAt: NOW.toISOString(),
    });
    expect(result.counts).toMatchObject({
      new: 3,
      invalid: 1,
      duplicateInFile: 1,
      duplicateExisting: 0,
    });
    const rounds = allRounds(db);
    expect(rounds).toHaveLength(3);
    expect(rounds.every((r) => r.importId === result.import.id && r.source === SOURCE)).toBe(true);
    expect(rounds.every((r) => r.observedAt === NOW.toISOString())).toBe(true);
  });

  it('marks a clean import as completed', () => {
    const { db, store } = setup();
    expect(run(db, store, VALID_CSV).confirm().import.status).toBe('completed');
  });

  it('imports JSON through the same rules', () => {
    const { db, store } = setup();
    const json = JSON.stringify({
      rounds: [
        { multiplier: 1.5, sourceRoundId: 1, eventAt: '2026-01-01T00:00:00Z' },
        { multiplier: '2.00', sourceRoundId: '2' },
        { multiplier: 2.345 },
      ],
    });
    const result = run(db, store, json, 'json').confirm();
    expect(result.import).toMatchObject({ format: 'json', recordsAccepted: 2, recordsRejected: 1 });
    expect(
      allRounds(db)
        .map((r) => r.sourceRoundId)
        .sort(),
    ).toEqual(['1', '2']);
  });

  it('never overwrites existing rounds and reports conflicts', () => {
    const { db, store } = setup();
    const existingId = insertRound(db, {
      multiplierX100: 999,
      source: SOURCE,
      sourceRoundId: 'SYN-2',
      observedAt: NOW.toISOString(),
      eventAt: null,
      importId: null,
      isSynthetic: false,
    });
    const { preview, confirm } = run(db, store, VALID_CSV);
    expect(preview.counts.duplicateExisting).toBe(1);
    expect(preview.rows[1]?.issues[0]?.message).toMatch(
      /DIFFERENT values; the stored round is kept unchanged/,
    );
    const result = confirm();
    expect(result.import.recordsDuplicate).toBe(1);
    const existing = allRounds(db).find((r) => r.id === existingId);
    expect(existing).toMatchObject({ multiplierX100: 999, eventAt: null, importId: null });
  });

  it('treats the same source ID under a different source as a different round', () => {
    const { db, store } = setup();
    run(db, store, VALID_CSV).confirm();
    const other = run(db, store, `${VALID_CSV}\n`, 'csv', 'another-synthetic-source').confirm();
    expect(other.import.recordsAccepted).toBe(3);
  });

  it('is deterministic when the same file is imported twice', () => {
    const { db, store } = setup();
    run(db, store, VALID_CSV).confirm();
    const second = run(db, store, VALID_CSV);
    expect(second.preview.alreadyImported?.importId).toBeGreaterThan(0);
    expect(second.preview.counts.duplicateExisting).toBe(3);
    expect(httpError(second.confirm).code).toBe('duplicate_import');
    // A re-export with different bytes but the same IDs is accepted as an import of 0 new rounds.
    const reexport = run(db, store, `${VALID_CSV}\n`).confirm();
    expect(reexport.import).toMatchObject({ recordsAccepted: 0, recordsDuplicate: 3 });
    expect(allRounds(db)).toHaveLength(3);
  });

  it('re-checks duplicates at confirm time', () => {
    const { db, store } = setup();
    const first = run(db, store, VALID_CSV);
    const second = run(db, store, `${VALID_CSV}\n`);
    first.confirm();
    const result = second.confirm();
    expect(result.import).toMatchObject({ recordsAccepted: 0, recordsDuplicate: 3 });
    expect(allRounds(db)).toHaveLength(3);
  });

  it('allows a preview to be confirmed only once', () => {
    const { db, store } = setup();
    const { confirm } = run(db, store, VALID_CSV);
    confirm();
    expect(httpError(confirm).code).toBe('preview_not_found');
  });

  it('refuses to confirm a file with no valid records', () => {
    const { db, store } = setup();
    expect(httpError(run(db, store, 'multiplier\nabc\n').confirm).code).toBe('nothing_to_import');
    expect(listImports(db, 10, 0).total).toBe(0);
  });

  it('rolls back completely on a database failure and records a failed import', () => {
    const { db, store } = setup();
    const logged: unknown[] = [];
    // Simulate a write failure part-way through the import (after two rounds were inserted).
    db.exec(`CREATE TRIGGER fail_third BEFORE INSERT ON rounds WHEN NEW.source_round_id = 'SYN-3'
             BEGIN SELECT RAISE(ABORT, 'simulated failure'); END;`);
    const preview = previewImport(
      db,
      store,
      { format: 'csv', source: SOURCE, content: VALID_CSV },
      NOW,
    );
    const error = httpError(() =>
      confirmImport(db, store, preview.previewId, { now: NOW, log: (_m, e) => logged.push(e) }),
    );
    expect(error.status).toBe(500);
    expect(error.code).toBe('database_write_failed');
    expect(error.message).not.toMatch(/simulated|SQL|trigger/i);
    expect(logged).toHaveLength(1);
    expect(allRounds(db)).toHaveLength(0);
    const history = listImports(db, 10, 0).items;
    expect(history).toHaveLength(1);
    expect(history[0]).toMatchObject({ status: 'failed', recordsAccepted: 0, recordsTotal: 3 });
    expect(history[0]?.errorSummary).toMatch(/rolled back/);
    // The failed attempt does not block a later successful import of the same file.
    db.exec('DROP TRIGGER fail_third');
    expect(run(db, store, VALID_CSV).confirm().import.recordsAccepted).toBe(3);
  });

  it('still reports failure, stores nothing and logs both errors when the failed-import history write also fails', () => {
    const { db, store } = setup();
    const logged: string[] = [];
    // Every data_imports insert fails: the import transaction AND the follow-up history write.
    db.exec(`CREATE TRIGGER fail_imports BEFORE INSERT ON data_imports
             BEGIN SELECT RAISE(ABORT, 'simulated failure'); END;`);
    const preview = previewImport(
      db,
      store,
      { format: 'csv', source: SOURCE, content: VALID_CSV },
      NOW,
    );
    const error = httpError(() =>
      confirmImport(db, store, preview.previewId, { now: NOW, log: (m) => logged.push(m) }),
    );
    expect(error.status).toBe(500);
    expect(error.code).toBe('database_write_failed');
    expect(logged).toEqual([
      'Import transaction failed and was rolled back',
      'Could not record the failed import in history',
    ]);
    expect(allRounds(db)).toHaveLength(0);
    expect(listImports(db, 10, 0).total).toBe(0);
  });

  it('enforces counter consistency and content-hash uniqueness in the database itself', () => {
    const { db, store } = setup();
    const result = run(db, store, VALID_CSV).confirm();
    expect(() =>
      db
        .prepare('UPDATE data_imports SET records_accepted = 99 WHERE id = ?')
        .run(result.import.id),
    ).toThrow(/inconsistent/);
    expect(() =>
      db
        .prepare(
          `INSERT INTO data_imports (source_description, source_kind, format, status, records_total, records_accepted,
             content_sha256, imported_at) VALUES ('x', 'file_import', 'csv', 'completed', 1, 1, ?, ?)`,
        )
        .run(result.import.contentSha256, NOW.toISOString()),
    ).toThrow(/UNIQUE/);
    expect(() => db.prepare('DELETE FROM data_imports WHERE id = ?').run(result.import.id)).toThrow(
      /FOREIGN KEY/,
    );
  });
});

describe('PreviewStore', () => {
  it('expires previews and caps how many are held', () => {
    let now = 0;
    const store = new PreviewStore(() => now, 1000, 2);
    const base = {
      format: 'csv' as const,
      source: SOURCE,
      notes: null,
      contentSha256: 'a'.repeat(64),
      records: [],
    };
    const a = store.create(base);
    const b = store.create(base);
    const c = store.create(base); // evicts a
    expect(store.take(a.id)).toBeNull();
    expect(store.size).toBe(2);
    now = 1000;
    expect(store.take(b.id)).toBeNull();
    expect(store.take(c.id)).toBeNull();
  });
});
