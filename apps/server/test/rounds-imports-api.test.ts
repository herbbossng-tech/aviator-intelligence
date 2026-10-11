import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  apiErrorSchema,
  importConfirmResponseSchema,
  importDtoSchema,
  importPreviewResponseSchema,
  importsListResponseSchema,
  IMPORT_LIMITS,
  manualRoundResponseSchema,
  overviewResponseSchema,
  roundsListResponseSchema,
} from '@aviator/shared';
import type { Db } from '../src/db/connection.js';
import { createTestDb, startTestServer } from './helpers.js';

// SYNTHETIC TEST FIXTURES: invented values for exercising the API, not real Aviator history.
const SOURCE = 'synthetic-test-fixture';

let db: Db;
let server: Awaited<ReturnType<typeof startTestServer>>;
let logged: unknown[];

beforeEach(async () => {
  db = createTestDb();
  logged = [];
  server = await startTestServer(db, (_m, e) => logged.push(e));
});
afterEach(async () => {
  await server.close();
  if (db.open) db.close();
});

const get = (path: string) => fetch(`${server.baseUrl}${path}`);
const send = (method: string, path: string, body: unknown) =>
  fetch(`${server.baseUrl}${path}`, {
    method,
    headers: { 'Content-Type': 'application/json' },
    body: typeof body === 'string' ? body : JSON.stringify(body),
  });
const post = (path: string, body: unknown) => send('POST', path, body);

async function errorOf(res: Response) {
  return apiErrorSchema.parse(await res.json()).error;
}

describe('POST /api/rounds (manual entry)', () => {
  it('stores a valid round and returns it', async () => {
    const res = await post('/api/rounds', {
      source: 'manual entry',
      multiplier: '2.35',
      sourceRoundId: 'SYN-M1',
      eventAt: '2026-01-31T15:05:09+01:00',
    });
    expect(res.status).toBe(201);
    const { round } = manualRoundResponseSchema.parse(await res.json());
    expect(round).toMatchObject({
      multiplierX100: 235,
      source: 'manual entry',
      sourceRoundId: 'SYN-M1',
      eventAt: '2026-01-31T14:05:09.000Z',
      importId: null,
    });
    const list = roundsListResponseSchema.parse(await (await get('/api/rounds')).json());
    expect(list.total).toBe(1);
    const overview = overviewResponseSchema.parse(await (await get('/api/overview')).json());
    expect(overview.rounds.total).toBe(1);
  });

  it('returns field-level validation errors and stores nothing', async () => {
    const res = await post('/api/rounds', {
      source: '',
      multiplier: '2.345',
      eventAt: '2026-01-31T14:05',
    });
    expect(res.status).toBe(400);
    const error = await errorOf(res);
    expect(error.code).toBe('validation_error');
    expect(error.details).toEqual([
      { path: 'source', code: 'missing_required_field', message: 'source is required' },
      expect.objectContaining({ path: 'multiplier', code: 'invalid_multiplier' }),
      expect.objectContaining({ path: 'eventAt', code: 'invalid_timestamp' }),
    ]);
    expect(roundsListResponseSchema.parse(await (await get('/api/rounds')).json()).total).toBe(0);
  });

  it('rejects unknown body fields', async () => {
    const res = await post('/api/rounds', { source: 's', multiplier: '2', isSynthetic: true });
    expect(res.status).toBe(400);
  });

  it('returns 409 for an existing source round ID and leaves it unchanged', async () => {
    const body = { source: SOURCE, multiplier: '2', sourceRoundId: 'SYN-D' };
    expect((await post('/api/rounds', body)).status).toBe(201);
    const res = await post('/api/rounds', { ...body, multiplier: '9' });
    expect(res.status).toBe(409);
    expect((await errorOf(res)).code).toBe('duplicate_source_id');
    const list = roundsListResponseSchema.parse(await (await get('/api/rounds')).json());
    expect(list.items.map((r) => r.multiplierX100)).toEqual([200]);
  });

  it('asks for confirmation before saving a possible duplicate without a source ID', async () => {
    const body = { source: SOURCE, multiplier: '1.5', eventAt: '2026-01-01T00:00:00Z' };
    expect((await post('/api/rounds', body)).status).toBe(201);
    const res = await post('/api/rounds', body);
    expect(res.status).toBe(409);
    expect((await errorOf(res)).code).toBe('possible_duplicate');
    expect((await post('/api/rounds', { ...body, allowPossibleDuplicate: true })).status).toBe(201);
    // Without an eventAt there is no evidence of duplication, so no prompt.
    expect((await post('/api/rounds', { source: SOURCE, multiplier: '1.5' })).status).toBe(201);
    expect((await post('/api/rounds', { source: SOURCE, multiplier: '1.5' })).status).toBe(201);
  });

  it('reports a failed write as a 500 without details and stores nothing', async () => {
    db.exec(
      `CREATE TRIGGER fail_all BEFORE INSERT ON rounds BEGIN SELECT RAISE(ABORT, 'secret internals'); END;`,
    );
    const res = await post('/api/rounds', { source: SOURCE, multiplier: '2' });
    expect(res.status).toBe(500);
    const error = await errorOf(res);
    expect(error).toEqual({
      code: 'database_write_failed',
      message: 'The round could not be saved. Nothing was stored.',
    });
    expect(JSON.stringify(error)).not.toMatch(/secret internals/);
    expect(logged).toHaveLength(1);
  });

  it('rejects malformed and oversized JSON bodies', async () => {
    const malformed = await post('/api/rounds', '{"source":');
    expect(malformed.status).toBe(400);
    expect((await errorOf(malformed)).code).toBe('invalid_request_json');
    const huge = await post('/api/rounds', { source: 'x'.repeat(200_000), multiplier: '2' });
    expect(huge.status).toBe(413);
    expect((await errorOf(huge)).code).toBe('payload_too_large');
  });
});

describe('GET /api/rounds filters', () => {
  beforeEach(async () => {
    for (const [multiplier, sourceRoundId, eventAt, source] of [
      ['1.20', 'ABC-1', '2026-01-01T00:00:10Z', SOURCE],
      ['3.40', 'ABC-2', '2026-01-01T00:00:20Z', SOURCE],
      ['10.00', 'XYZ_1', null, SOURCE],
      ['2.00', 'ABC-3', '2026-01-01T00:00:05Z', 'other-synthetic'],
    ] as const) {
      expect(
        (await post('/api/rounds', { source, multiplier, sourceRoundId, eventAt })).status,
      ).toBe(201);
    }
  });

  const ids = async (query: string) =>
    roundsListResponseSchema
      .parse(await (await get(`/api/rounds${query}`)).json())
      .items.map((r) => r.sourceRoundId);

  it('filters by source, ID substring, multiplier range and paginates', async () => {
    expect(await ids(`?source=other-synthetic`)).toEqual(['ABC-3']);
    expect(await ids('?q=abc&source=' + SOURCE)).toEqual(['ABC-2', 'ABC-1']);
    expect(await ids('?q=_')).toEqual(['XYZ_1']); // LIKE wildcards are escaped
    expect(await ids('?minMultiplier=2&maxMultiplier=5')).toEqual(['ABC-3', 'ABC-2']);
    expect(await ids('?sort=event_asc')).toEqual(['ABC-3', 'ABC-1', 'ABC-2', 'XYZ_1']);
    expect(await ids('?limit=2&offset=2')).toEqual(['ABC-2', 'ABC-1']);
  });

  it('lists sources with counts', async () => {
    const body = (await (await get('/api/rounds/sources')).json()) as { items: unknown[] };
    expect(body.items).toEqual([
      { source: 'other-synthetic', rounds: 1 },
      { source: SOURCE, rounds: 3 },
    ]);
  });

  it.each([
    '?minMultiplier=abc',
    '?minMultiplier=5&maxMultiplier=2',
    '?sort=random',
    '?importId=0',
    '?q=',
  ])('rejects %s', async (query) => {
    const res = await get(`/api/rounds${query}`);
    expect(res.status).toBe(400);
    expect((await errorOf(res)).code).toBe('validation_error');
  });
});

describe('import endpoints', () => {
  const csv = 'multiplier,sourceRoundId\n1.50,SYN-1\n2.00,SYN-2\nbad,SYN-3\n';

  it('previews, confirms, and records history', async () => {
    const previewRes = await post('/api/imports/preview', {
      format: 'csv',
      source: SOURCE,
      notes: 'test',
      content: csv,
    });
    expect(previewRes.status).toBe(200);
    const preview = importPreviewResponseSchema.parse(await previewRes.json());
    expect(preview.counts).toMatchObject({ total: 3, new: 2, invalid: 1 });

    const confirmRes = await post('/api/imports', { previewId: preview.previewId });
    expect(confirmRes.status).toBe(201);
    const confirmed = importConfirmResponseSchema.parse(await confirmRes.json());
    expect(confirmed.import).toMatchObject({
      status: 'completed_with_rejections',
      recordsAccepted: 2,
      notes: 'test',
    });

    const history = importsListResponseSchema.parse(await (await get('/api/imports')).json());
    expect(history.items.map((i) => i.id)).toEqual([confirmed.import.id]);
    const detail = importDtoSchema.parse(
      await (await get(`/api/imports/${confirmed.import.id}`)).json(),
    );
    expect(detail.recordsRejected).toBe(1);
    const filtered = roundsListResponseSchema.parse(
      await (await get(`/api/rounds?importId=${confirmed.import.id}`)).json(),
    );
    expect(filtered.total).toBe(2);
    const overview = overviewResponseSchema.parse(await (await get('/api/overview')).json());
    expect(overview.imports).toMatchObject({ total: 1, recordsAccepted: 2, recordsRejected: 1 });

    const again = await post('/api/imports', { previewId: preview.previewId });
    expect(again.status).toBe(404);
    expect((await errorOf(again)).code).toBe('preview_not_found');
  });

  it('blocks a second import of identical content with 409', async () => {
    const first = importPreviewResponseSchema.parse(
      await (
        await post('/api/imports/preview', { format: 'csv', source: SOURCE, content: csv })
      ).json(),
    );
    expect((await post('/api/imports', { previewId: first.previewId })).status).toBe(201);
    const second = importPreviewResponseSchema.parse(
      await (
        await post('/api/imports/preview', { format: 'csv', source: SOURCE, content: csv })
      ).json(),
    );
    expect(second.alreadyImported).not.toBeNull();
    const res = await post('/api/imports', { previewId: second.previewId });
    expect(res.status).toBe(409);
    expect((await errorOf(res)).code).toBe('duplicate_import');
  });

  it.each([
    [{ format: 'csv', source: SOURCE, content: 'nope\n1\n' }, 422, 'invalid_header'],
    [{ format: 'json', source: SOURCE, content: '{bad' }, 422, 'invalid_json'],
    [{ format: 'csv', source: SOURCE, content: '' }, 422, 'empty_file'],
    [{ format: 'csv', source: '   ', content: csv }, 422, 'invalid_source'],
    [{ format: 'xml', source: SOURCE, content: csv }, 400, 'validation_error'],
    [{ format: 'csv', source: SOURCE, content: csv, extra: 1 }, 400, 'validation_error'],
  ])('rejects %j with %d %s', async (body, status, code) => {
    const res = await post('/api/imports/preview', body);
    expect(res.status).toBe(status);
    expect((await errorOf(res)).code).toBe(code);
  });

  it('rejects files over the byte limit with 413', async () => {
    const content = `multiplier\n${'1.5\n'.repeat(Math.ceil(IMPORT_LIMITS.maxBytes / 4) + 1)}`;
    const res = await post('/api/imports/preview', { format: 'csv', source: SOURCE, content });
    expect(res.status).toBe(413);
    expect((await errorOf(res)).code).toBe('file_too_large');
  });

  it('rejects too many records with 422', async () => {
    const content = `multiplier\n${'2\n'.repeat(IMPORT_LIMITS.maxRecords + 1)}`;
    const res = await post('/api/imports/preview', { format: 'csv', source: SOURCE, content });
    expect(res.status).toBe(422);
    expect((await errorOf(res)).code).toBe('too_many_records');
  });

  it('validates confirm and detail parameters', async () => {
    expect((await post('/api/imports', { previewId: 'not-a-uuid' })).status).toBe(400);
    expect(
      (await post('/api/imports', { previewId: crypto.randomUUID(), records: [] })).status,
    ).toBe(400);
    expect((await get('/api/imports/abc')).status).toBe(400);
    expect((await get('/api/imports/999')).status).toBe(404);
  });

  it('discards a preview on request', async () => {
    const preview = importPreviewResponseSchema.parse(
      await (
        await post('/api/imports/preview', { format: 'csv', source: SOURCE, content: csv })
      ).json(),
    );
    expect((await send('DELETE', `/api/imports/previews/${preview.previewId}`, {})).status).toBe(
      204,
    );
    expect((await post('/api/imports', { previewId: preview.previewId })).status).toBe(404);
  });

  it('returns 500 database_write_failed when the import transaction fails', async () => {
    db.exec(`CREATE TRIGGER fail_two BEFORE INSERT ON rounds WHEN NEW.source_round_id = 'SYN-2'
             BEGIN SELECT RAISE(ABORT, 'simulated failure'); END;`);
    const preview = importPreviewResponseSchema.parse(
      await (
        await post('/api/imports/preview', { format: 'csv', source: SOURCE, content: csv })
      ).json(),
    );
    const res = await post('/api/imports', { previewId: preview.previewId });
    expect(res.status).toBe(500);
    expect((await errorOf(res)).code).toBe('database_write_failed');
    expect(roundsListResponseSchema.parse(await (await get('/api/rounds')).json()).total).toBe(0);
    const history = importsListResponseSchema.parse(await (await get('/api/imports')).json());
    expect(history.items[0]).toMatchObject({ status: 'failed', recordsAccepted: 0 });
  });
});
