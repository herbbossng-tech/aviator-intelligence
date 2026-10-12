import { describe, expect, it } from 'vitest';
import {
  parseEventAtInput,
  parseMultiplierInput,
  parseSourceLabelInput,
  parseSourceRoundIdInput,
  validateRoundRecord,
} from './rounds.js';

const NOW = new Date('2026-06-01T12:00:00.000Z');

describe('parseMultiplierInput', () => {
  it.each([
    ['1', 100],
    ['1.00', 100],
    ['2.5', 250],
    [' 2.35 ', 235],
    ['1000000', 100_000_000],
    [2.35, 235],
    [6, 600],
    [1.1, 110],
  ])('accepts %j as %d', (input, expected) => {
    expect(parseMultiplierInput(input)).toEqual({ ok: true, value: expected });
  });

  it.each([
    [undefined, 'missing_required_field'],
    [null, 'missing_required_field'],
    ['', 'missing_required_field'],
    ['   ', 'missing_required_field'],
  ])('reports %j as missing', (input, code) => {
    const result = parseMultiplierInput(input);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.issue.code).toBe(code);
  });

  it.each([
    ['0', /below the 1.00x minimum/],
    [0, /below the 1.00x minimum/],
    ['0.99', /below the 1.00x minimum/],
    ['-2', /must be positive/],
    [-2, /must be positive/],
    ['2.345', /more than two decimal places/],
    [2.345, /more than two decimal places/],
    [0.1 + 0.2, /more than two decimal places/],
    ['1000000.01', /exceeds/],
    ['1e3', /not a plain decimal/],
    [1e21, /not a plain decimal/],
    ['2,5', /not a plain decimal/],
    ['2.35x', /not a plain decimal/],
    ['abc', /not a plain decimal/],
    ['.5', /not a plain decimal/],
    ['NaN', /not a plain decimal/],
    [Number.NaN, /finite/],
    [Number.POSITIVE_INFINITY, /finite/],
    [true, /text or a number/],
    [{}, /text or a number/],
  ])('rejects %j', (input, message) => {
    const result = parseMultiplierInput(input);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.issue.code).toBe('invalid_multiplier');
      expect(result.issue.message).toMatch(message);
    }
  });
});

describe('parseEventAtInput', () => {
  it.each([
    ['2026-01-31T14:05:09Z', '2026-01-31T14:05:09.000Z'],
    ['2026-01-31T14:05Z', '2026-01-31T14:05:00.000Z'],
    ['2026-01-31T14:05:09.5Z', '2026-01-31T14:05:09.500Z'],
    ['2026-01-31T15:05:09.123+01:00', '2026-01-31T14:05:09.123Z'],
    ['2026-01-31T09:35:09-04:30', '2026-01-31T14:05:09.000Z'],
    ['2024-02-29T00:00:00Z', '2024-02-29T00:00:00.000Z'],
  ])('normalises %s to UTC', (input, expected) => {
    expect(parseEventAtInput(input, NOW)).toEqual({ ok: true, value: expected });
  });

  it('treats absent values as null without inventing a time', () => {
    expect(parseEventAtInput(undefined, NOW)).toEqual({ ok: true, value: null });
    expect(parseEventAtInput('', NOW)).toEqual({ ok: true, value: null });
    expect(parseEventAtInput(null, NOW)).toEqual({ ok: true, value: null });
  });

  it.each([
    '2026-01-31T14:05:09', // no offset: ambiguous local time
    '2026-01-31 14:05:09Z', // space separator
    '2026-01-31',
    '31/01/2026 14:05',
    '2026-02-30T00:00:00Z',
    '2025-02-29T00:00:00Z',
    '2026-13-01T00:00:00Z',
    '2026-01-31T24:00:00Z',
    '2026-01-31T14:60:00Z',
    '2026-01-31T14:05:09.1234Z',
    '2026-01-31T14:05:09+15:00',
    '1999-12-31T23:59:59Z',
    '2026-06-01T12:06:00Z', // more than 5 minutes in the future
    'yesterday',
  ])('rejects %s', (input) => {
    const result = parseEventAtInput(input, NOW);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.issue.code).toBe('invalid_timestamp');
  });

  describe('UTC offset boundaries (-14:00 to +14:00)', () => {
    it.each([
      ['2026-01-31T10:00:00Z', '2026-01-31T10:00:00.000Z'],
      ['2026-01-31T10:00:00+14:00', '2026-01-30T20:00:00.000Z'],
      ['2026-01-31T10:00:00-14:00', '2026-02-01T00:00:00.000Z'],
      ['2026-01-31T10:00:00+13:59', '2026-01-30T20:01:00.000Z'],
      ['2026-01-31T10:00:00-13:59', '2026-01-31T23:59:00.000Z'],
      ['2026-01-31T10:00:00+01:00', '2026-01-31T09:00:00.000Z'],
      ['2026-01-31T10:00:00-04:30', '2026-01-31T14:30:00.000Z'],
      ['2026-01-31T10:00:00+00:00', '2026-01-31T10:00:00.000Z'],
    ])('accepts %s as %s', (input, expected) => {
      expect(parseEventAtInput(input, NOW)).toEqual({ ok: true, value: expected });
    });

    it.each([
      '2026-01-31T10:00:00+14:01',
      '2026-01-31T10:00:00+14:59',
      '2026-01-31T10:00:00-14:01',
      '2026-01-31T10:00:00-14:30',
      '2026-01-31T10:00:00+15:00',
      '2026-01-31T10:00:00-15:00',
      '2026-01-31T10:00:00+13:60',
      '2026-01-31T10:00:00+99:00',
    ])('rejects %s', (input) => {
      const result = parseEventAtInput(input, NOW);
      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.issue.code).toBe('invalid_timestamp');
        expect(result.issue.message).toMatch(/not a valid date and time/);
      }
    });
  });

  it.each([
    ['2026-06-01T12:05:00Z', true], // exactly at the 5-minute future tolerance
    ['2026-06-01T12:05:00.001Z', false],
    ['2000-01-01T00:00:00Z', true], // earliest accepted instant
    ['1999-12-31T23:59:59.999Z', false],
    ['2000-01-01T00:30:00+01:00', false], // 1999-12-31T23:30Z once normalised
    ['0099-12-31T00:00:00Z', false], // Date.UTC maps years 0-99 to 1900-1999; still rejected
    ['0000-01-01T00:00:00Z', false],
    ['2026-01-31T23:59:60Z', false], // leap seconds are not accepted
    ['2026-01-31T10:00:00.000000Z', false], // more than millisecond precision
  ])('applies range and precision boundaries: %s -> %s', (input, accepted) => {
    expect(parseEventAtInput(input, NOW).ok).toBe(accepted);
  });

  it('rejects non-string timestamps', () => {
    expect(parseEventAtInput(1_700_000_000_000, NOW).ok).toBe(false);
  });
});

describe('parseSourceRoundIdInput', () => {
  it('accepts text and non-negative integers, trims, and treats blanks as absent', () => {
    expect(parseSourceRoundIdInput(' r-1 ')).toEqual({ ok: true, value: 'r-1' });
    expect(parseSourceRoundIdInput(42)).toEqual({ ok: true, value: '42' });
    expect(parseSourceRoundIdInput('')).toEqual({ ok: true, value: null });
  });

  it.each([-1, 1.5, 'a'.repeat(129), 'bad\nid', {}])('rejects %j', (input) => {
    const result = parseSourceRoundIdInput(input);
    expect(result.ok).toBe(false);
  });
});

describe('parseSourceLabelInput', () => {
  it('accepts a trimmed label', () => {
    expect(parseSourceLabelInput('  manual entry ')).toEqual({ ok: true, value: 'manual entry' });
  });

  it.each([
    [undefined, 'missing_required_field'],
    ['  ', 'missing_required_field'],
    [42, 'invalid_source'],
    ['x'.repeat(101), 'invalid_source'],
    ['tab\there', 'invalid_source'],
  ])('rejects %j with %s', (input, code) => {
    const result = parseSourceLabelInput(input);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.issue.code).toBe(code);
  });
});

describe('validateRoundRecord', () => {
  it('returns the canonical record for valid input', () => {
    expect(
      validateRoundRecord(
        { multiplier: '2.35', sourceRoundId: 'r-1', eventAt: '2026-01-31T14:05:09Z' },
        NOW,
      ),
    ).toEqual({
      ok: true,
      record: { multiplierX100: 235, sourceRoundId: 'r-1', eventAt: '2026-01-31T14:05:09.000Z' },
    });
  });

  it('accepts a record with only a multiplier', () => {
    expect(validateRoundRecord({ multiplier: '1.00' }, NOW)).toEqual({
      ok: true,
      record: { multiplierX100: 100, sourceRoundId: null, eventAt: null },
    });
  });

  it('reports every problem, including unknown fields', () => {
    const result = validateRoundRecord(
      { multiplier: 'x', eventAt: 'nope', source: 'per-row' },
      NOW,
    );
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.issues.map((i) => i.code).sort()).toEqual(
        ['invalid_multiplier', 'invalid_timestamp', 'unknown_field'].sort(),
      );
    }
  });
});
