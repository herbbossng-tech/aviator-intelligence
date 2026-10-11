import { parse as parseCsv, CsvError } from 'csv-parse/sync';
import {
  IMPORT_LIMITS,
  ROUND_RECORD_FIELDS,
  describeInput,
  type ImportFormat,
} from '@aviator/shared';
import { ImportFileError } from './errors.js';

/** One record as read from the file, before validation. */
export interface RawRecord {
  recordNumber: number;
  line: number | null;
  /** Field values, or null if the record itself is structurally invalid. */
  fields: Record<string, unknown> | null;
  structuralError: string | null;
}

const MAX_CSV_FIELD_BYTES = 4096;

function truncate(text: string, max = 200): string {
  return text.length > max ? `${text.slice(0, max - 3)}...` : text;
}

/** Rejects content that cannot be valid UTF-8 text before parsing begins. */
export function checkContent(content: string, maxBytes: number = IMPORT_LIMITS.maxBytes): void {
  const bytes = Buffer.byteLength(content, 'utf8');
  if (bytes > maxBytes) {
    throw new ImportFileError(
      'file_too_large',
      `File is ${bytes.toLocaleString('en')} bytes; the limit is ${maxBytes.toLocaleString('en')} bytes`,
    );
  }
  if (content.includes('\uFFFD') || content.includes('\u0000')) {
    throw new ImportFileError(
      'invalid_encoding',
      'File is not valid UTF-8 text (it contains replacement or NUL characters). Re-save it as UTF-8.',
    );
  }
  if (content.replace(/^\uFEFF/, '').trim() === '') {
    throw new ImportFileError('empty_file', 'File is empty');
  }
}

/**
 * CSV: comma-delimited, first row is the header, RFC 4180 quoting (quoted fields may
 * contain commas, quotes ("") and line breaks). A UTF-8 BOM is ignored. Blank lines are
 * skipped. Header names must be exactly multiplier, sourceRoundId, eventAt (any order;
 * multiplier required). Unknown or repeated headers reject the whole file.
 */
export function parseCsvRecords(
  content: string,
  maxRecords: number = IMPORT_LIMITS.maxRecords,
): RawRecord[] {
  let parsed: { record: string[]; info: { lines: number } }[];
  try {
    parsed = parseCsv(content, {
      bom: true,
      relax_column_count: true,
      skip_empty_lines: true,
      info: true,
      max_record_size: MAX_CSV_FIELD_BYTES,
      // Stop reading early once the limit is exceeded (header + maxRecords + 1).
      to: maxRecords + 2,
    }) as unknown as { record: string[]; info: { lines: number } }[];
  } catch (error) {
    if (error instanceof CsvError) {
      const line = (error as CsvError & { lines?: number }).lines;
      throw new ImportFileError(
        'invalid_csv',
        `CSV could not be parsed: ${truncate(error.message)}`,
        typeof line === 'number' ? { line } : undefined,
      );
    }
    throw error;
  }
  const [header, ...rows] = parsed;
  if (!header) throw new ImportFileError('empty_file', 'File is empty');
  const columns = header.record.map((name) => name.trim());
  const seen = new Set<string>();
  for (const name of columns) {
    if (!(ROUND_RECORD_FIELDS as readonly string[]).includes(name)) {
      throw new ImportFileError(
        'invalid_header',
        `Unknown CSV column ${describeInput(name)}. Allowed columns: ${ROUND_RECORD_FIELDS.join(', ')}`,
        { line: 1 },
      );
    }
    if (seen.has(name)) {
      throw new ImportFileError('invalid_header', `CSV column "${name}" appears more than once`, {
        line: 1,
      });
    }
    seen.add(name);
  }
  if (!seen.has('multiplier')) {
    throw new ImportFileError('invalid_header', 'CSV header must include a "multiplier" column', {
      line: 1,
    });
  }
  if (rows.length === 0) throw new ImportFileError('empty_file', 'CSV has a header but no records');
  if (rows.length > maxRecords) {
    throw new ImportFileError(
      'too_many_records',
      `File has more than ${maxRecords.toLocaleString('en')} records; split it into smaller files`,
    );
  }
  return rows.map((row, index) => {
    const base = { recordNumber: index + 1, line: row.info.lines };
    if (row.record.length !== columns.length) {
      return {
        ...base,
        fields: null,
        structuralError: `row has ${row.record.length} field(s) but the header has ${columns.length}`,
      };
    }
    const fields: Record<string, unknown> = {};
    columns.forEach((name, i) => {
      fields[name] = row.record[i];
    });
    return { ...base, fields, structuralError: null };
  });
}

/**
 * JSON: either an array of record objects, or a wrapper object {"rounds": [...]} with no
 * other keys. Content is only ever passed to JSON.parse; nothing is evaluated.
 */
export function parseJsonRecords(
  content: string,
  maxRecords: number = IMPORT_LIMITS.maxRecords,
): RawRecord[] {
  let data: unknown;
  try {
    data = JSON.parse(content.replace(/^\uFEFF/, ''));
  } catch (error) {
    throw new ImportFileError(
      'invalid_json',
      `JSON could not be parsed: ${truncate(error instanceof Error ? error.message : String(error))}`,
    );
  }
  let records: unknown[];
  if (Array.isArray(data)) {
    records = data;
  } else if (
    typeof data === 'object' &&
    data !== null &&
    Object.keys(data).length === 1 &&
    Array.isArray((data as { rounds?: unknown }).rounds)
  ) {
    records = (data as { rounds: unknown[] }).rounds;
  } else {
    throw new ImportFileError(
      'invalid_json',
      'JSON must be an array of round objects, or an object of the form {"rounds": [...]} with no other keys',
    );
  }
  if (records.length === 0) throw new ImportFileError('empty_file', 'JSON contains no records');
  if (records.length > maxRecords) {
    throw new ImportFileError(
      'too_many_records',
      `File has ${records.length.toLocaleString('en')} records; the limit is ${maxRecords.toLocaleString('en')}`,
    );
  }
  return records.map((item, index) => {
    const base = { recordNumber: index + 1, line: null };
    if (typeof item !== 'object' || item === null || Array.isArray(item)) {
      return {
        ...base,
        fields: null,
        structuralError: `record must be an object, got ${describeInput(item)}`,
      };
    }
    return { ...base, fields: item as Record<string, unknown>, structuralError: null };
  });
}

export function parseRecords(format: ImportFormat, content: string): RawRecord[] {
  checkContent(content);
  return format === 'csv' ? parseCsvRecords(content) : parseJsonRecords(content);
}
