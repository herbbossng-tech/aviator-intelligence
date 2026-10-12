import {
  IMPORT_LIMITS,
  sameRoundValues,
  validateRoundRecord,
  type CanonicalRoundRecord,
  type ImportCounts,
  type PreviewIssue,
  type PreviewRow,
  type PreviewRowStatus,
  type RoundIssue,
} from '@aviator/shared';
import type { Db } from '../db/connection.js';
import { findRoundBySourceId, hasPossibleDuplicate } from '../db/repositories/rounds.js';
import type { RawRecord } from './parse.js';

/** Result of validating a record and comparing it with the rest of the same file. */
export interface FileClassifiedRecord {
  recordNumber: number;
  line: number | null;
  record: CanonicalRoundRecord | null;
  fileStatus: 'valid' | 'invalid' | 'duplicate_in_file';
  issues: RoundIssue[];
  warnings: RoundIssue[];
}

function listNumbers(numbers: number[]): string {
  const shown = numbers.slice(0, 5).join(', ');
  return numbers.length > 5 ? `${shown} and ${numbers.length - 5} more` : shown;
}

/**
 * Validates every record independently, then applies the in-file duplicate policy for
 * records that carry a sourceRoundId:
 * - identical repeats: the first occurrence is kept, later ones are duplicate_in_file;
 * - repeats with different multiplier or eventAt: ALL occurrences are rejected
 *   (conflicting_duplicate_in_file), because there is no safe way to choose one.
 * Records without a sourceRoundId are never deduplicated; identical (eventAt, multiplier)
 * pairs only raise a possible_duplicate warning.
 */
export function classifyFileRecords(raw: RawRecord[], now: Date): FileClassifiedRecord[] {
  const out: FileClassifiedRecord[] = raw.map((r) => {
    const base = { recordNumber: r.recordNumber, line: r.line, warnings: [] as RoundIssue[] };
    if (r.fields === null) {
      return {
        ...base,
        record: null,
        fileStatus: 'invalid',
        issues: [
          { code: 'invalid_record', field: null, message: r.structuralError ?? 'invalid record' },
        ],
      };
    }
    const result = validateRoundRecord(r.fields, now);
    return result.ok
      ? { ...base, record: result.record, fileStatus: 'valid', issues: [] }
      : { ...base, record: null, fileStatus: 'invalid', issues: result.issues };
  });

  const bySourceId = new Map<string, FileClassifiedRecord[]>();
  const byEventAndMultiplier = new Map<string, FileClassifiedRecord[]>();
  for (const item of out) {
    if (item.fileStatus !== 'valid' || !item.record) continue;
    const key = item.record.sourceRoundId;
    if (key !== null) {
      bySourceId.set(key, [...(bySourceId.get(key) ?? []), item]);
    } else if (item.record.eventAt !== null) {
      const k = `${item.record.eventAt}|${item.record.multiplierX100}`;
      byEventAndMultiplier.set(k, [...(byEventAndMultiplier.get(k) ?? []), item]);
    }
  }

  for (const [sourceRoundId, group] of bySourceId) {
    if (group.length < 2) continue;
    const [first, ...rest] = group as [FileClassifiedRecord, ...FileClassifiedRecord[]];
    const identical = rest.every((item) => sameRoundValues(first.record!, item.record!));
    if (identical) {
      for (const item of rest) {
        item.fileStatus = 'duplicate_in_file';
        item.issues = [
          {
            code: 'duplicate_in_file',
            field: 'sourceRoundId',
            message: `sourceRoundId "${sourceRoundId.slice(0, 40)}" repeats record ${first.recordNumber} with identical values; skipped`,
          },
        ];
      }
    } else {
      const numbers = group.map((g) => g.recordNumber);
      for (const item of group) {
        item.fileStatus = 'invalid';
        item.record = null;
        item.issues = [
          {
            code: 'conflicting_duplicate_in_file',
            field: 'sourceRoundId',
            message: `sourceRoundId "${sourceRoundId.slice(0, 40)}" appears in records ${listNumbers(numbers)} with different values; all were rejected`,
          },
        ];
      }
    }
  }

  for (const group of byEventAndMultiplier.values()) {
    if (group.length < 2) continue;
    const numbers = group.map((g) => g.recordNumber);
    for (const item of group) {
      item.warnings.push({
        code: 'possible_duplicate',
        field: null,
        message: `records ${listNumbers(numbers)} have the same eventAt and multiplier and no sourceRoundId; they will all be stored`,
      });
    }
  }
  return out;
}

export interface AssessedRecord extends FileClassifiedRecord {
  status: PreviewRowStatus;
}

/** Compares file-valid records with what is already stored for the declared source. */
export function assessAgainstDatabase(
  db: Db,
  source: string,
  records: FileClassifiedRecord[],
): AssessedRecord[] {
  return records.map((item) => {
    if (item.fileStatus === 'invalid') return { ...item, status: 'invalid' };
    if (item.fileStatus === 'duplicate_in_file') return { ...item, status: 'duplicate_in_file' };
    const record = item.record!;
    if (record.sourceRoundId !== null) {
      const existing = findRoundBySourceId(db, source, record.sourceRoundId);
      if (existing) {
        const conflict =
          existing.multiplierX100 !== record.multiplierX100 || existing.eventAt !== record.eventAt;
        return {
          ...item,
          status: 'duplicate_existing',
          issues: [
            {
              code: 'duplicate_source_id',
              field: 'sourceRoundId',
              message: conflict
                ? `round ${existing.id} already has this sourceRoundId with DIFFERENT values; the stored round is kept unchanged`
                : `already stored as round ${existing.id}; skipped`,
            },
          ],
        };
      }
      return { ...item, status: 'new' };
    }
    const warnings =
      record.eventAt !== null &&
      hasPossibleDuplicate(db, source, record.eventAt, record.multiplierX100)
        ? [
            ...item.warnings,
            {
              code: 'possible_duplicate' as const,
              field: null,
              message:
                'a stored round has the same source, eventAt and multiplier; this record has no sourceRoundId, so it will still be stored',
            },
          ]
        : item.warnings;
    return { ...item, status: 'new', warnings };
  });
}

export function countRecords(records: AssessedRecord[]): ImportCounts {
  const counts: ImportCounts = {
    total: records.length,
    new: 0,
    invalid: 0,
    duplicateExisting: 0,
    duplicateInFile: 0,
    possibleDuplicates: 0,
  };
  for (const r of records) {
    if (r.status === 'new') counts.new += 1;
    else if (r.status === 'invalid') counts.invalid += 1;
    else if (r.status === 'duplicate_existing') counts.duplicateExisting += 1;
    else counts.duplicateInFile += 1;
    if (r.warnings.length > 0) counts.possibleDuplicates += 1;
  }
  return counts;
}

/** Bounded view of the assessment for the API response. */
export function summarise(records: AssessedRecord[]): {
  rows: PreviewRow[];
  rowsTruncated: boolean;
  issues: PreviewIssue[];
  issuesTruncated: boolean;
} {
  const rows = records.slice(0, IMPORT_LIMITS.maxPreviewRows).map((r) => ({
    recordNumber: r.recordNumber,
    line: r.line,
    status: r.status,
    multiplierX100: r.record?.multiplierX100 ?? null,
    sourceRoundId: r.record?.sourceRoundId ?? null,
    eventAt: r.record?.eventAt ?? null,
    issues: r.issues.slice(0, 10),
    warnings: r.warnings.slice(0, 5),
  }));
  const issues: PreviewIssue[] = [];
  let issueCount = 0;
  for (const r of records) {
    const all = [
      ...r.issues.map((i) => ({ ...i, severity: 'error' as const })),
      ...r.warnings.map((i) => ({ ...i, severity: 'warning' as const })),
    ];
    for (const issue of all) {
      issueCount += 1;
      if (issues.length < IMPORT_LIMITS.maxIssues) {
        issues.push({ ...issue, recordNumber: r.recordNumber, line: r.line });
      }
    }
  }
  return {
    rows,
    rowsTruncated: records.length > rows.length,
    issues,
    issuesTruncated: issueCount > issues.length,
  };
}
