import { z } from 'zod';
import { MAX_MULTIPLIER_X100, MIN_ROUND_MULTIPLIER_X100, MULTIPLIER_SCALE } from './multiplier.js';

/**
 * Canonical round record: the ONE validation path used by CSV import, JSON import,
 * manual entry (server) and the manual-entry form (client).
 *
 * Field names are identical in CSV headers, JSON keys and the manual-entry API body:
 *   multiplier     required  decimal text or JSON number, at most two decimals, >= 1.00x
 *   sourceRoundId  optional  identifier assigned by the data source (never invented)
 *   eventAt        optional  ISO-8601 date-time WITH an explicit offset (Z or +hh:mm)
 *
 * The source/provenance label is declared once per import (or per manual entry), not
 * per row. SQLite columns use snake_case (multiplier_x100, source_round_id, event_at).
 */
export const ROUND_RECORD_FIELDS = ['multiplier', 'sourceRoundId', 'eventAt'] as const;
export type RoundRecordField = (typeof ROUND_RECORD_FIELDS)[number];

export const MAX_SOURCE_LENGTH = 100;
export const MAX_SOURCE_ROUND_ID_LENGTH = 128;
/** Event times before this instant are rejected as implausible. */
export const EARLIEST_EVENT_AT = '2000-01-01T00:00:00.000Z';
/** Event times may be at most this far in the future (clock-skew tolerance). */
export const EVENT_AT_FUTURE_TOLERANCE_MS = 5 * 60 * 1000;

export const ROUND_ISSUE_CODES = [
  'missing_required_field',
  'invalid_multiplier',
  'invalid_timestamp',
  'invalid_source',
  'invalid_source_round_id',
  'unknown_field',
  'invalid_record',
  'duplicate_source_id',
  'duplicate_in_file',
  'conflicting_duplicate_in_file',
  'possible_duplicate',
] as const;
export const roundIssueCodeSchema = z.enum(ROUND_ISSUE_CODES);
export type RoundIssueCode = z.infer<typeof roundIssueCodeSchema>;

export const roundIssueSchema = z.object({
  code: roundIssueCodeSchema,
  field: z.string().nullable(),
  message: z.string(),
});
export type RoundIssue = z.infer<typeof roundIssueSchema>;

export interface CanonicalRoundRecord {
  multiplierX100: number;
  sourceRoundId: string | null;
  eventAt: string | null;
}

type FieldResult<T> = { ok: true; value: T } | { ok: false; issue: RoundIssue };

// eslint-disable-next-line no-control-regex -- deliberately matching control characters
const CONTROL_CHARS = /[\u0000-\u001f\u007f-\u009f]/;
const MULTIPLIER_TEXT = /^(\d{1,9})(?:\.(\d{1,2}))?$/;
const TOO_PRECISE = /^\d+\.\d{3,}$/;
const ISO_DATE_TIME =
  /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})(?::(\d{2})(?:\.(\d{1,3}))?)?(Z|([+-])(\d{2}):(\d{2}))$/;

function fail(
  code: RoundIssueCode,
  field: string | null,
  message: string,
): { ok: false; issue: RoundIssue } {
  return { ok: false, issue: { code, field, message } };
}

/** Bounded, single-line rendering of user input for error messages. */
export function describeInput(value: unknown): string {
  let text: string;
  if (typeof value === 'string') text = JSON.stringify(value);
  else if (typeof value === 'number' || typeof value === 'boolean') text = String(value);
  else if (value === null) text = 'null';
  else if (Array.isArray(value)) text = 'an array';
  else text = `a ${typeof value}`;
  return text.length > 40 ? `${text.slice(0, 37)}...` : text;
}

function isBlank(value: unknown): boolean {
  return (
    value === undefined || value === null || (typeof value === 'string' && value.trim() === '')
  );
}

/**
 * Parses a multiplier into its exact x100 integer. Accepts decimal text ("2", "2.5",
 * "2.35") or a finite JSON number whose shortest decimal form has at most two decimals.
 * Nothing is rounded: "2.345" is rejected, not turned into 2.35.
 */
export function parseMultiplierInput(value: unknown): FieldResult<number> {
  const field = 'multiplier';
  if (isBlank(value)) return fail('missing_required_field', field, 'multiplier is required');
  let text: string;
  if (typeof value === 'number') {
    if (!Number.isFinite(value))
      return fail('invalid_multiplier', field, 'multiplier must be a finite number');
    text = String(value);
  } else if (typeof value === 'string') {
    text = value.trim();
  } else {
    return fail(
      'invalid_multiplier',
      field,
      `multiplier must be text or a number, got ${describeInput(value)}`,
    );
  }
  if (text.startsWith('-')) {
    return fail(
      'invalid_multiplier',
      field,
      `multiplier must be positive, got ${describeInput(text)}`,
    );
  }
  if (TOO_PRECISE.test(text)) {
    return fail(
      'invalid_multiplier',
      field,
      `multiplier ${describeInput(text)} has more than two decimal places; values are never rounded`,
    );
  }
  const match = MULTIPLIER_TEXT.exec(text);
  if (!match) {
    return fail(
      'invalid_multiplier',
      field,
      `multiplier ${describeInput(text)} is not a plain decimal number such as 2 or 2.35`,
    );
  }
  const x100 = Number(match[1]) * MULTIPLIER_SCALE + Number((match[2] ?? '0').padEnd(2, '0'));
  if (x100 < MIN_ROUND_MULTIPLIER_X100) {
    return fail(
      'invalid_multiplier',
      field,
      `multiplier ${describeInput(text)} is below the 1.00x minimum`,
    );
  }
  if (x100 > MAX_MULTIPLIER_X100) {
    return fail(
      'invalid_multiplier',
      field,
      `multiplier ${describeInput(text)} exceeds the 1000000.00x limit`,
    );
  }
  return { ok: true, value: x100 };
}

/**
 * Parses an optional event time. Requires ISO-8601 with an explicit offset so local
 * times are never guessed to be UTC. Returns the instant normalised to UTC with
 * millisecond precision (e.g. 2026-01-31T13:05:09.000Z), or null when absent.
 */
/**
 * Strictly parses an ISO-8601 date-time WITH an explicit offset (Z or ±hh:mm, at most
 * ±14:00) into epoch milliseconds. Returns 'format' if the text does not match the
 * accepted shape and 'invalid' if it matches but names an impossible date, time or offset.
 * Shared by event-time validation and the analytics date-range filters.
 */
export function parseIsoDateTimeWithOffset(text: string): number | 'format' | 'invalid' {
  const m = ISO_DATE_TIME.exec(text);
  if (!m) return 'format';
  const [year, month, day, hour, minute] = [m[1], m[2], m[3], m[4], m[5]].map(Number) as [
    number,
    number,
    number,
    number,
    number,
  ];
  const second = Number(m[6] ?? '0');
  const millis = Number((m[7] ?? '0').padEnd(3, '0'));
  const offsetSign = m[9] === '-' ? -1 : 1;
  const offsetHours = Number(m[10] ?? '0');
  const offsetMinutes = Number(m[11] ?? '0');
  const calendar = new Date(Date.UTC(year, month - 1, day));
  const validDate =
    month >= 1 &&
    month <= 12 &&
    calendar.getUTCFullYear() === year &&
    calendar.getUTCMonth() === month - 1 &&
    calendar.getUTCDate() === day;
  // UTC offsets run from -14:00 to +14:00 inclusive: at 14 hours the minutes must be 00.
  const validOffset =
    offsetMinutes <= 59 && (offsetHours < 14 || (offsetHours === 14 && offsetMinutes === 0));
  if (!validDate || hour > 23 || minute > 59 || second > 59 || !validOffset) return 'invalid';
  return (
    Date.UTC(year, month - 1, day, hour, minute, second, millis) -
    offsetSign * (offsetHours * 60 + offsetMinutes) * 60_000
  );
}

export function parseEventAtInput(value: unknown, now: Date): FieldResult<string | null> {
  const field = 'eventAt';
  if (isBlank(value)) return { ok: true, value: null };
  if (typeof value !== 'string') {
    return fail('invalid_timestamp', field, `eventAt must be text, got ${describeInput(value)}`);
  }
  const text = value.trim();
  const instant = parseIsoDateTimeWithOffset(text);
  if (instant === 'format') {
    return fail(
      'invalid_timestamp',
      field,
      `eventAt ${describeInput(text)} must be ISO-8601 with an explicit offset, e.g. 2026-01-31T14:05:09Z or 2026-01-31T15:05:09+01:00`,
    );
  }
  if (instant === 'invalid') {
    return fail(
      'invalid_timestamp',
      field,
      `eventAt ${describeInput(text)} is not a valid date and time`,
    );
  }
  if (instant < Date.parse(EARLIEST_EVENT_AT)) {
    return fail('invalid_timestamp', field, `eventAt ${describeInput(text)} is before 2000-01-01`);
  }
  if (instant > now.getTime() + EVENT_AT_FUTURE_TOLERANCE_MS) {
    return fail('invalid_timestamp', field, `eventAt ${describeInput(text)} is in the future`);
  }
  return { ok: true, value: new Date(instant).toISOString() };
}

/** Optional identifier assigned by the source. Integers from JSON are accepted as their decimal text. */
export function parseSourceRoundIdInput(value: unknown): FieldResult<string | null> {
  const field = 'sourceRoundId';
  if (isBlank(value)) return { ok: true, value: null };
  let text: string;
  if (typeof value === 'number') {
    if (!Number.isSafeInteger(value) || value < 0) {
      return fail(
        'invalid_source_round_id',
        field,
        'numeric sourceRoundId must be a non-negative integer',
      );
    }
    text = String(value);
  } else if (typeof value === 'string') {
    text = value.trim();
  } else {
    return fail(
      'invalid_source_round_id',
      field,
      `sourceRoundId must be text, got ${describeInput(value)}`,
    );
  }
  if (text.length > MAX_SOURCE_ROUND_ID_LENGTH) {
    return fail(
      'invalid_source_round_id',
      field,
      `sourceRoundId is longer than ${MAX_SOURCE_ROUND_ID_LENGTH} characters`,
    );
  }
  if (CONTROL_CHARS.test(text)) {
    return fail('invalid_source_round_id', field, 'sourceRoundId contains control characters');
  }
  return { ok: true, value: text };
}

/** The provenance label stored on every round, e.g. "manual entry" or "my-export-2026-01". */
export function parseSourceLabelInput(value: unknown): FieldResult<string> {
  const field = 'source';
  if (isBlank(value)) return fail('missing_required_field', field, 'source is required');
  if (typeof value !== 'string') return fail('invalid_source', field, 'source must be text');
  const text = value.trim();
  if (text.length > MAX_SOURCE_LENGTH) {
    return fail('invalid_source', field, `source is longer than ${MAX_SOURCE_LENGTH} characters`);
  }
  if (CONTROL_CHARS.test(text))
    return fail('invalid_source', field, 'source contains control characters');
  return { ok: true, value: text };
}

export type RecordValidation =
  { ok: true; record: CanonicalRoundRecord } | { ok: false; issues: RoundIssue[] };

/** Validates one raw record (object of field -> value). All problems are reported, not just the first. */
export function validateRoundRecord(raw: Record<string, unknown>, now: Date): RecordValidation {
  const issues: RoundIssue[] = [];
  for (const key of Object.keys(raw)) {
    if (!(ROUND_RECORD_FIELDS as readonly string[]).includes(key)) {
      issues.push({
        code: 'unknown_field',
        field: key.slice(0, 40),
        message: `unknown field ${describeInput(key)}`,
      });
    }
  }
  const multiplier = parseMultiplierInput(raw.multiplier);
  const sourceRoundId = parseSourceRoundIdInput(raw.sourceRoundId);
  const eventAt = parseEventAtInput(raw.eventAt, now);
  if (!multiplier.ok) issues.push(multiplier.issue);
  if (!sourceRoundId.ok) issues.push(sourceRoundId.issue);
  if (!eventAt.ok) issues.push(eventAt.issue);
  if (issues.length > 0 || !multiplier.ok || !sourceRoundId.ok || !eventAt.ok) {
    return { ok: false, issues };
  }
  return {
    ok: true,
    record: {
      multiplierX100: multiplier.value,
      sourceRoundId: sourceRoundId.value,
      eventAt: eventAt.value,
    },
  };
}

/** Two records with the same source round ID are "the same round"; are their values identical? */
export function sameRoundValues(a: CanonicalRoundRecord, b: CanonicalRoundRecord): boolean {
  return a.multiplierX100 === b.multiplierX100 && a.eventAt === b.eventAt;
}
