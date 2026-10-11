import { describe, expect, it } from 'vitest';
import { ImportFileError } from '../src/imports/errors.js';
import { checkContent, parseCsvRecords, parseJsonRecords } from '../src/imports/parse.js';

// SYNTHETIC TEST INPUT: illustrative values only, not real Aviator history.

function fileError(fn: () => unknown): ImportFileError {
  try {
    fn();
  } catch (error) {
    if (error instanceof ImportFileError) return error;
    throw error;
  }
  throw new Error('expected an ImportFileError');
}

describe('checkContent', () => {
  it('rejects oversized, empty and non-UTF-8 content', () => {
    expect(fileError(() => checkContent('x'.repeat(11), 10)).code).toBe('file_too_large');
    expect(fileError(() => checkContent('  \n ')).code).toBe('empty_file');
    expect(fileError(() => checkContent('\uFEFF')).code).toBe('empty_file');
    expect(fileError(() => checkContent('multiplier\n1.5\uFFFD')).code).toBe('invalid_encoding');
    expect(fileError(() => checkContent('multiplier\n1.5\u0000')).code).toBe('invalid_encoding');
  });

  it('measures the limit in UTF-8 bytes, not characters', () => {
    // '₦' is 3 bytes in UTF-8.
    expect(() => checkContent('₦₦₦', 9)).not.toThrow();
    expect(fileError(() => checkContent('₦₦₦₦', 9)).code).toBe('file_too_large');
  });
});

describe('parseCsvRecords', () => {
  it('parses the canonical header in any order and keeps raw text values', () => {
    const records = parseCsvRecords(
      'eventAt,multiplier,sourceRoundId\n2026-01-01T00:00:00Z,1.50,r-1\n,2,\n',
    );
    expect(records).toEqual([
      {
        recordNumber: 1,
        line: 2,
        fields: { eventAt: '2026-01-01T00:00:00Z', multiplier: '1.50', sourceRoundId: 'r-1' },
        structuralError: null,
      },
      {
        recordNumber: 2,
        line: 3,
        fields: { eventAt: '', multiplier: '2', sourceRoundId: '' },
        structuralError: null,
      },
    ]);
  });

  it('handles a BOM, CRLF, blank lines and quoted fields with commas, quotes and line breaks', () => {
    const csv = '\uFEFFmultiplier,sourceRoundId\r\n"1.25","a,b"\r\n\r\n"3","say ""hi""\nthere"\r\n';
    const records = parseCsvRecords(csv);
    expect(records.map((r) => r.fields)).toEqual([
      { multiplier: '1.25', sourceRoundId: 'a,b' },
      { multiplier: '3', sourceRoundId: 'say "hi"\nthere' },
    ]);
    expect(records[1]?.line).toBe(5);
  });

  it('flags rows with the wrong number of fields without rejecting the file', () => {
    const records = parseCsvRecords('multiplier,sourceRoundId\n1.5,a\n2\n3,c,extra\n');
    expect(records.map((r) => r.structuralError)).toEqual([
      null,
      'row has 1 field(s) but the header has 2',
      'row has 3 field(s) but the header has 2',
    ]);
  });

  it.each([
    ['multiplier,source\n1.5,x\n', 'invalid_header', /Unknown CSV column "source"/],
    ['Multiplier\n1.5\n', 'invalid_header', /Unknown CSV column/],
    ['sourceRoundId\nr-1\n', 'invalid_header', /must include a "multiplier" column/],
    ['multiplier,multiplier\n1,2\n', 'invalid_header', /more than once/],
    ['multiplier\n', 'empty_file', /no records/],
    ['multiplier\n"1.5\n', 'invalid_csv', /Quote Not Closed/],
  ])('rejects %j as %s', (csv, code, message) => {
    const error = fileError(() => parseCsvRecords(csv));
    expect(error.code).toBe(code);
    expect(error.message).toMatch(message);
  });

  it('rejects files with more records than the limit', () => {
    const csv = `multiplier\n${'1.5\n'.repeat(4)}`;
    expect(parseCsvRecords(csv, 4)).toHaveLength(4);
    expect(fileError(() => parseCsvRecords(`${csv}1.5\n`, 4)).code).toBe('too_many_records');
  });
});

describe('parseJsonRecords', () => {
  it('accepts an array of records', () => {
    const records = parseJsonRecords('[{"multiplier":"1.5"},{"multiplier":2,"sourceRoundId":7}]');
    expect(records.map((r) => r.fields)).toEqual([
      { multiplier: '1.5' },
      { multiplier: 2, sourceRoundId: 7 },
    ]);
    expect(records[0]?.line).toBeNull();
  });

  it('accepts the {"rounds": [...]} wrapper', () => {
    expect(parseJsonRecords('{"rounds":[{"multiplier":"1.5"}]}')).toHaveLength(1);
  });

  it('marks non-object records as structurally invalid', () => {
    const records = parseJsonRecords('[{"multiplier":"1.5"}, 3, null, ["1.5"]]');
    expect(records.map((r) => r.structuralError === null)).toEqual([true, false, false, false]);
  });

  it.each([
    ['{not json', 'invalid_json'],
    ['"a string"', 'invalid_json'],
    ['{"multiplier":"1.5"}', 'invalid_json'],
    ['{"rounds":[{"multiplier":"1.5"}],"extra":1}', 'invalid_json'],
    ['{"rounds":"nope"}', 'invalid_json'],
    ['[]', 'empty_file'],
  ])('rejects %j as %s', (json, code) => {
    expect(fileError(() => parseJsonRecords(json)).code).toBe(code);
  });

  it('rejects files with more records than the limit', () => {
    const json = JSON.stringify(Array.from({ length: 5 }, () => ({ multiplier: '1.5' })));
    expect(fileError(() => parseJsonRecords(json, 4)).code).toBe('too_many_records');
  });

  it('never evaluates content', () => {
    const records = parseJsonRecords('[{"multiplier":"1.5","__proto__":{"polluted":true}}]');
    expect(({} as Record<string, unknown>).polluted).toBeUndefined();
    expect(Object.keys(records[0]?.fields ?? {})).toContain('__proto__');
  });
});
