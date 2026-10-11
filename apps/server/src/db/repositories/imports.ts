import type { ImportDto, ImportFormat, ImportStatus } from '@aviator/shared';
import type { Db } from '../connection.js';

interface ImportRow {
  id: number;
  source_description: string;
  notes: string | null;
  source_kind: 'manual_entry' | 'file_import';
  format: ImportFormat | null;
  status: ImportStatus;
  records_total: number;
  records_accepted: number;
  records_rejected: number;
  records_duplicate: number;
  content_sha256: string | null;
  error_summary: string | null;
  started_at: string | null;
  completed_at: string | null;
  imported_at: string;
}

const IMPORT_COLUMNS = `id, source_description, notes, source_kind, format, status, records_total,
  records_accepted, records_rejected, records_duplicate, content_sha256, error_summary,
  started_at, completed_at, imported_at`;

function toDto(row: ImportRow): ImportDto {
  return {
    id: row.id,
    source: row.source_description,
    notes: row.notes,
    sourceKind: row.source_kind,
    format: row.format,
    status: row.status,
    recordsTotal: row.records_total,
    recordsAccepted: row.records_accepted,
    recordsRejected: row.records_rejected,
    recordsDuplicate: row.records_duplicate,
    contentSha256: row.content_sha256,
    errorSummary: row.error_summary,
    startedAt: row.started_at,
    completedAt: row.completed_at,
    importedAt: row.imported_at,
  };
}

export function listImports(
  db: Db,
  limit: number,
  offset: number,
): { items: ImportDto[]; total: number } {
  const rows = db
    .prepare(`SELECT ${IMPORT_COLUMNS} FROM data_imports ORDER BY id DESC LIMIT ? OFFSET ?`)
    .all(limit, offset) as ImportRow[];
  const { total } = db.prepare('SELECT COUNT(*) AS total FROM data_imports').get() as {
    total: number;
  };
  return { items: rows.map(toDto), total };
}

export function getImport(db: Db, id: number): ImportDto | null {
  const row = db.prepare(`SELECT ${IMPORT_COLUMNS} FROM data_imports WHERE id = ?`).get(id) as
    ImportRow | undefined;
  return row ? toDto(row) : null;
}

/** The successful import (if any) that already stored this exact file content. */
export function findSuccessfulImportByHash(
  db: Db,
  contentSha256: string,
): { importId: number; importedAt: string } | null {
  const row = db
    .prepare(
      `SELECT id, imported_at FROM data_imports
        WHERE content_sha256 = ? AND status IN ('completed', 'completed_with_rejections')
        LIMIT 1`,
    )
    .get(contentSha256) as { id: number; imported_at: string } | undefined;
  return row ? { importId: row.id, importedAt: row.imported_at } : null;
}

export interface ImportRecordInput {
  source: string;
  notes: string | null;
  format: ImportFormat;
  status: ImportStatus;
  recordsTotal: number;
  recordsAccepted: number;
  recordsRejected: number;
  recordsDuplicate: number;
  contentSha256: string;
  errorSummary: string | null;
  startedAt: string;
  completedAt: string | null;
  importedAt: string;
}

export function insertImport(db: Db, input: ImportRecordInput): number {
  const result = db
    .prepare(
      `INSERT INTO data_imports (source_description, notes, source_kind, format, status, records_total,
         records_accepted, records_rejected, records_duplicate, content_sha256, error_summary,
         started_at, completed_at, imported_at)
       VALUES (?, ?, 'file_import', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    .run(
      input.source,
      input.notes,
      input.format,
      input.status,
      input.recordsTotal,
      input.recordsAccepted,
      input.recordsRejected,
      input.recordsDuplicate,
      input.contentSha256,
      input.errorSummary,
      input.startedAt,
      input.completedAt,
      input.importedAt,
    );
  return Number(result.lastInsertRowid);
}

export function finalizeImport(
  db: Db,
  id: number,
  update: Pick<
    ImportRecordInput,
    'status' | 'recordsAccepted' | 'recordsRejected' | 'recordsDuplicate' | 'completedAt'
  >,
): void {
  db.prepare(
    `UPDATE data_imports
        SET status = ?, records_accepted = ?, records_rejected = ?, records_duplicate = ?, completed_at = ?
      WHERE id = ?`,
  ).run(
    update.status,
    update.recordsAccepted,
    update.recordsRejected,
    update.recordsDuplicate,
    update.completedAt,
    id,
  );
}
