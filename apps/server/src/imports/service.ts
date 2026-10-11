import { createHash } from 'node:crypto';
import {
  parseSourceLabelInput,
  type ImportConfirmResponse,
  type ImportCounts,
  type ImportPreviewRequest,
  type ImportPreviewResponse,
  type ImportStatus,
} from '@aviator/shared';
import type { Db } from '../db/connection.js';
import {
  findSuccessfulImportByHash,
  finalizeImport,
  getImport,
  insertImport,
} from '../db/repositories/imports.js';
import { findRoundBySourceId, insertRound } from '../db/repositories/rounds.js';
import { HttpError } from '../http/errors.js';
import { assessAgainstDatabase, classifyFileRecords, countRecords, summarise } from './classify.js';
import { ImportFileError } from './errors.js';
import { parseRecords } from './parse.js';
import type { PreviewStore, StoredPreview } from './previewStore.js';

export function sha256(content: string): string {
  return createHash('sha256').update(content, 'utf8').digest('hex');
}

/** Parses and validates a file, compares it with stored rounds, and stores the preview. Writes nothing. */
export function previewImport(
  db: Db,
  store: PreviewStore,
  request: ImportPreviewRequest,
  now: Date,
): ImportPreviewResponse {
  const source = parseSourceLabelInput(request.source);
  if (!source.ok) throw new ImportFileError('invalid_source', source.issue.message);
  const notes = request.notes?.trim() || null;
  const raw = parseRecords(request.format, request.content);
  const fileRecords = classifyFileRecords(raw, now);
  const assessed = assessAgainstDatabase(db, source.value, fileRecords);
  const contentSha256 = sha256(request.content);
  const preview = store.create({
    format: request.format,
    source: source.value,
    notes,
    contentSha256,
    records: fileRecords,
  });
  return {
    previewId: preview.id,
    expiresAt: new Date(preview.expiresAt).toISOString(),
    format: request.format,
    source: source.value,
    notes,
    contentSha256,
    alreadyImported: findSuccessfulImportByHash(db, contentSha256),
    counts: countRecords(assessed),
    ...summarise(assessed),
  };
}

class DuplicateImportError extends Error {}

export interface ConfirmOptions {
  now: Date;
  log: (message: string, error: unknown) => void;
}

/**
 * Stores the previewed records in ONE transaction: the import row, every inserted round
 * and the final counters commit together or not at all. Duplicates are re-checked inside
 * the transaction because the database may have changed since the preview.
 * If the transaction fails, a separate 'failed' import row is recorded with zero accepted
 * records and a generic error summary (internal error details are only logged).
 */
export function confirmImport(
  db: Db,
  store: PreviewStore,
  previewId: string,
  { now, log }: ConfirmOptions,
): ImportConfirmResponse {
  const preview = store.take(previewId);
  if (!preview) {
    throw new HttpError(
      404,
      'preview_not_found',
      'This preview has expired or was already used. Validate the file again.',
    );
  }
  const total = preview.records.length;
  const invalid = preview.records.filter((r) => r.fileStatus === 'invalid').length;
  const duplicateInFile = preview.records.filter(
    (r) => r.fileStatus === 'duplicate_in_file',
  ).length;
  const candidates = preview.records.filter((r) => r.fileStatus === 'valid');
  if (candidates.length === 0) {
    throw new HttpError(422, 'nothing_to_import', 'The file contains no valid records to import.');
  }

  const importedAt = now.toISOString();
  try {
    const importId = db.transaction(() =>
      commit(db, preview, importedAt, { total, invalid, duplicateInFile }),
    )();
    const stored = getImport(db, importId);
    if (!stored) throw new Error('import row missing after commit');
    return {
      import: stored,
      counts: {
        total,
        new: stored.recordsAccepted,
        invalid,
        duplicateExisting: stored.recordsDuplicate - duplicateInFile,
        duplicateInFile,
        possibleDuplicates: candidates.filter((c) => c.warnings.length > 0).length,
      },
    };
  } catch (error) {
    if (error instanceof DuplicateImportError) {
      throw new HttpError(
        409,
        'duplicate_import',
        'This exact file content has already been imported successfully; nothing was stored.',
      );
    }
    log('Import transaction failed and was rolled back', error);
    recordFailedImport(db, preview, importedAt, { total, invalid }, log);
    throw new HttpError(
      500,
      'database_write_failed',
      'The import could not be saved. The transaction was rolled back and no records were stored.',
    );
  }
}

function commit(
  db: Db,
  preview: StoredPreview,
  importedAt: string,
  fileCounts: { total: number; invalid: number; duplicateInFile: number },
): number {
  if (findSuccessfulImportByHash(db, preview.contentSha256)) throw new DuplicateImportError();
  const importId = insertImport(db, {
    source: preview.source,
    notes: preview.notes,
    format: preview.format,
    status: 'pending',
    recordsTotal: fileCounts.total,
    recordsAccepted: 0,
    recordsRejected: 0,
    recordsDuplicate: 0,
    contentSha256: preview.contentSha256,
    errorSummary: null,
    startedAt: importedAt,
    completedAt: null,
    importedAt,
  });
  let accepted = 0;
  let duplicateExisting = 0;
  for (const item of preview.records) {
    if (item.fileStatus !== 'valid' || !item.record) continue;
    const { sourceRoundId } = item.record;
    if (sourceRoundId !== null && findRoundBySourceId(db, preview.source, sourceRoundId)) {
      duplicateExisting += 1; // never overwrite an existing round
      continue;
    }
    insertRound(db, {
      ...item.record,
      source: preview.source,
      observedAt: importedAt,
      importId,
      isSynthetic: false,
    });
    accepted += 1;
  }
  const duplicates = duplicateExisting + fileCounts.duplicateInFile;
  const status: ImportStatus =
    fileCounts.invalid + duplicates > 0 ? 'completed_with_rejections' : 'completed';
  finalizeImport(db, importId, {
    status,
    recordsAccepted: accepted,
    recordsRejected: fileCounts.invalid,
    recordsDuplicate: duplicates,
    completedAt: new Date().toISOString(),
  });
  return importId;
}

function recordFailedImport(
  db: Db,
  preview: StoredPreview,
  importedAt: string,
  counts: Pick<ImportCounts, 'total' | 'invalid'>,
  log: (message: string, error: unknown) => void,
): void {
  try {
    insertImport(db, {
      source: preview.source,
      notes: preview.notes,
      format: preview.format,
      status: 'failed',
      recordsTotal: counts.total,
      recordsAccepted: 0,
      recordsRejected: counts.invalid,
      recordsDuplicate: 0,
      contentSha256: preview.contentSha256,
      errorSummary:
        'Database write failed; the transaction was rolled back and no records from this file were stored.',
      startedAt: importedAt,
      completedAt: new Date().toISOString(),
      importedAt,
    });
  } catch (error) {
    log('Could not record the failed import in history', error);
  }
}
