import http, { type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import express from 'express';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  analyticsResponseSchema,
  apiErrorSchema,
  importPreviewResponseSchema,
  MAX_ANALYTICS_ROUNDS,
  type AnalyticsResponse,
} from '@aviator/shared';
import type { Db } from '../src/db/connection.js';
import { insertRound } from '../src/db/repositories/rounds.js';
import { createErrorHandler } from '../src/http/errors.js';
import { analyticsRouter } from '../src/http/routes/analytics.js';
import { createTestDb, startTestServer } from './helpers.js';

// SYNTHETIC TEST FIXTURES: invented rounds used only to exercise the analytics API.
// Rows inserted with isSynthetic=false here exist only in an in-memory test database.

let db: Db;
let server: Awaited<ReturnType<typeof startTestServer>>;

beforeEach(async () => {
  db = createTestDb();
  server = await startTestServer(db);
});
afterEach(async () => {
  await server.close();
  if (db.open) db.close();
});

function seed(
  rows: { m: number; source?: string; eventAt?: string | null; synthetic?: boolean }[],
): void {
  for (const r of rows) {
    insertRound(db, {
      multiplierX100: r.m,
      source: r.source ?? 'synthetic-a',
      sourceRoundId: null,
      observedAt: '2026-06-01T00:00:00.000Z',
      eventAt: r.eventAt ?? null,
      importId: null,
      isSynthetic: r.synthetic ?? false,
    });
  }
}

async function analytics(query = ''): Promise<AnalyticsResponse> {
  const res = await fetch(`${server.baseUrl}/api/analytics${query}`);
  expect(res.status).toBe(200);
  return analyticsResponseSchema.parse(await res.json());
}

describe('GET /api/analytics', () => {
  it('returns an explicit empty result for an empty database', async () => {
    const body = await analytics();
    expect(body.dataset.roundsIncluded).toBe(0);
    expect(body.summary).toBeNull();
    expect(body.thresholds.map((t) => t.thresholdX100)).toEqual([
      120, 150, 200, 300, 500, 1000, 2000,
    ]);
    for (const t of body.thresholds)
      expect(t).toMatchObject({ count: 0, denominator: 0, proportion: null, ci95: null });
    expect(body.histogram.denominator).toBe(0);
    expect(body.histogram.bins.every((b) => b.count === 0 && b.proportion === null)).toBe(true);
    expect(body.method.ordering).toBe('order_independent');
    expect(JSON.stringify(body)).not.toMatch(/NaN|Infinity/);
  });

  it('describes the stored rounds', async () => {
    seed([
      { m: 100, eventAt: '2026-01-01T00:00:00.000Z' },
      { m: 150, eventAt: '2026-01-01T00:00:10.000Z' },
      { m: 200, eventAt: '2026-01-01T00:00:20.000Z' },
      { m: 200 },
      { m: 1250, source: 'synthetic-b', eventAt: '2026-01-02T00:00:00.000Z' },
    ]);
    const body = await analytics();
    expect(body.dataset).toMatchObject({
      roundsIncluded: 5,
      distinctSources: 2,
      eventTime: {
        withEventAt: 4,
        withoutEventAt: 1,
        earliestEventAt: '2026-01-01T00:00:00.000Z',
        latestEventAt: '2026-01-02T00:00:00.000Z',
      },
      exclusions: [],
    });
    expect(body.summary).toMatchObject({
      count: 5,
      minX100: 100,
      maxX100: 1250,
      meanX100: 380,
      medianX100: 200,
    });
    const at200 = body.thresholds.find((t) => t.thresholdX100 === 200)!;
    expect(at200).toMatchObject({ count: 3, denominator: 5, proportion: 0.6 });
    expect(at200.ci95!.lower).toBeLessThan(0.6);
    expect(at200.ci95!.upper).toBeGreaterThan(0.6);
    expect(body.histogram.bins.reduce((s, b) => s + b.count, 0)).toBe(5);
  });

  it('applies source, multiplier-range and custom-threshold filters', async () => {
    seed([{ m: 100 }, { m: 150 }, { m: 300 }, { m: 900, source: 'synthetic-b' }]);
    const bySource = await analytics('?source=synthetic-b');
    expect(bySource.dataset.roundsIncluded).toBe(1);
    expect(bySource.dataset.filters.source).toBe('synthetic-b');
    const byRange = await analytics('?minMultiplier=1.5&maxMultiplier=3');
    expect(byRange.summary).toMatchObject({ count: 2, minX100: 150, maxX100: 300 });
    expect(byRange.dataset.filters).toMatchObject({
      minMultiplierX100: 150,
      maxMultiplierX100: 300,
    });
    const custom = await analytics('?thresholds=9,1.5,1.5');
    expect(custom.thresholds.map((t) => [t.thresholdX100, t.count])).toEqual([
      [150, 3],
      [900, 1],
    ]);
  });

  it('applies the event-time range and reports rounds excluded for lacking an event time', async () => {
    seed([
      { m: 100, eventAt: '2026-01-01T00:00:00.000Z' },
      { m: 200, eventAt: '2026-01-31T23:59:59.999Z' },
      { m: 300, eventAt: '2026-02-01T00:00:00.000Z' }, // eventTo is exclusive
      { m: 400 },
      { m: 500 },
    ]);
    const body = await analytics('?eventFrom=2026-01-01T00:00:00Z&eventTo=2026-02-01T00:00:00Z');
    expect(body.dataset.roundsIncluded).toBe(2);
    expect(body.dataset.exclusions).toEqual([
      expect.objectContaining({ reason: 'no_event_time_with_date_filter', count: 2 }),
    ]);
    expect(body.dataset.filters.eventFrom).toBe('2026-01-01T00:00:00.000Z');
  });

  it('never includes synthetic fixtures and says how many were excluded', async () => {
    seed([{ m: 200 }, { m: 5000, synthetic: true }]);
    const body = await analytics();
    expect(body.dataset.roundsIncluded).toBe(1);
    expect(body.summary!.maxX100).toBe(200);
    expect(body.dataset.exclusions).toEqual([
      expect.objectContaining({ reason: 'synthetic_test_fixture', count: 1 }),
    ]);
  });

  it('is reproducible for the same data and filters', async () => {
    seed([{ m: 100 }, { m: 175 }, { m: 175 }, { m: 260 }, { m: 10_500 }]);
    expect(await analytics('?thresholds=2')).toEqual(await analytics('?thresholds=2'));
  });

  it('analyses rounds imported through the import workflow', async () => {
    const csv = 'multiplier,sourceRoundId\n1.00,S-1\n2.50,S-2\n7.00,S-3\nbad,S-4\n';
    const preview = importPreviewResponseSchema.parse(
      await (
        await fetch(`${server.baseUrl}/api/imports/preview`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ format: 'csv', source: 'synthetic-import', content: csv }),
        })
      ).json(),
    );
    const confirm = await fetch(`${server.baseUrl}/api/imports`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ previewId: preview.previewId }),
    });
    expect(confirm.status).toBe(201);
    const body = await analytics('?source=synthetic-import');
    expect(body.summary).toMatchObject({ count: 3, minX100: 100, maxX100: 700 });
  });

  it.each([
    '?thresholds=2.345',
    '?thresholds=',
    '?minMultiplier=abc',
    '?minMultiplier=5&maxMultiplier=2',
    '?eventFrom=2026-01-01',
    '?eventFrom=2026-02-01T00:00:00Z&eventTo=2026-01-01T00:00:00Z',
    '?importId=-1',
    '?limit=10',
    '?sort=event_asc',
  ])('rejects %s with 400 validation_error', async (query) => {
    const res = await fetch(`${server.baseUrl}/api/analytics${query}`);
    expect(res.status).toBe(400);
    expect(apiErrorSchema.parse(await res.json()).error.code).toBe('validation_error');
  });

  it('is behind the loopback Host guard like every other route', async () => {
    const port = new URL(server.baseUrl).port;
    for (const host of ['attacker.example', '[::1]evil.example']) {
      const status = await new Promise<number>((resolve, reject) => {
        http
          .get(
            { host: '127.0.0.1', port, path: '/api/analytics', headers: { Host: host } },
            (res) => {
              res.resume();
              resolve(res.statusCode ?? 0);
            },
          )
          .on('error', reject);
      });
      expect(status).toBe(403);
    }
  });

  it('accepts only GET', async () => {
    const res = await fetch(`${server.baseUrl}/api/analytics`, { method: 'POST', body: '{}' });
    expect(res.status).toBe(404);
  });
});

describe('GET /api/analytics edge cases', () => {
  it.each([
    '?source=a&source=b', // repeated parameters arrive as arrays
    '?thresholds=1.5&thresholds=2',
    '?thresholds=2,',
    '?thresholds=2,,3',
    '?source=',
    '?source=%20',
    '?minMultiplier=',
    '?minMultiplier=1e3',
    '?maxMultiplier=1000000.01',
    '?importId=abc',
    '?importId=1.5',
    '?eventFrom=2026-01-01T00:00:00Z&eventTo=2026-01-01T00:00:00Z', // empty half-open range
    '?eventFrom=2026-01-01T00:00:00.0001Z',
  ])('rejects %s with 400 validation_error', async (query) => {
    const res = await fetch(`${server.baseUrl}/api/analytics${query}`);
    expect(res.status).toBe(400);
    expect(apiErrorSchema.parse(await res.json()).error.code).toBe('validation_error');
  });

  it('treats SQL-looking input as a literal source label', async () => {
    seed([{ m: 200, source: 'synthetic-a' }]);
    const body = await analytics(`?source=${encodeURIComponent("synthetic-a' OR 1=1--")}`);
    expect(body.dataset.roundsIncluded).toBe(0);
    expect(body.dataset.filters.source).toBe("synthetic-a' OR 1=1--");
    expect((await analytics()).dataset.roundsIncluded).toBe(1);
  });

  it('scopes exclusion counts to the other filters', async () => {
    seed([
      { m: 150, source: 'synthetic-a' }, // undated, source a -> excluded by the date filter
      { m: 200, source: 'synthetic-b' }, // undated, other source -> not counted
      { m: 300, source: 'synthetic-a', eventAt: '2026-01-01T00:00:00.000Z' },
      { m: 400, source: 'synthetic-b', eventAt: '2026-01-01T00:00:00.000Z' },
      { m: 900, source: 'synthetic-a', synthetic: true }, // undated synthetic: outside any date range
    ]);
    const dated = await analytics('?source=synthetic-a&eventFrom=2026-01-01T00:00:00Z');
    expect(dated.dataset.roundsIncluded).toBe(1);
    expect(dated.dataset.exclusions).toEqual([
      expect.objectContaining({ reason: 'no_event_time_with_date_filter', count: 1 }),
    ]);
    const bySource = await analytics('?source=synthetic-a&minMultiplier=2');
    expect(bySource.dataset.roundsIncluded).toBe(1);
    expect(bySource.dataset.exclusions).toEqual([
      expect.objectContaining({ reason: 'synthetic_test_fixture', count: 1 }),
    ]);
    const unknownImport = await analytics('?importId=99999');
    expect(unknownImport.dataset).toMatchObject({ roundsIncluded: 0, exclusions: [] });
  });

  it('allows a 1.00x threshold, which every round meets', async () => {
    seed([{ m: 100 }, { m: 250 }]);
    const body = await analytics('?thresholds=1');
    expect(body.thresholds).toEqual([
      {
        thresholdX100: 100,
        count: 2,
        denominator: 2,
        proportion: 1,
        ci95: expect.objectContaining({ upper: 1 }),
      },
    ]);
  });
});

describe('analytics size limit', () => {
  async function withLimit(maxRounds: number) {
    const app = express();
    app.use('/api', analyticsRouter(db, { maxRounds }));
    app.use(createErrorHandler(() => {}));
    const srv = await new Promise<Server>((resolve) => {
      const s = app.listen(0, '127.0.0.1', () => resolve(s));
    });
    const { port } = srv.address() as AddressInfo;
    return { url: `http://127.0.0.1:${port}`, close: () => new Promise((r) => srv.close(r)) };
  }

  it('returns 422 dataset_too_large when the selection exceeds the limit, and succeeds at the limit', async () => {
    seed([{ m: 100 }, { m: 200 }, { m: 300 }]);
    const limited = await withLimit(2);
    try {
      const over = await fetch(`${limited.url}/api/analytics`);
      expect(over.status).toBe(422);
      expect(apiErrorSchema.parse(await over.json()).error.code).toBe('dataset_too_large');
      const narrowed = await fetch(`${limited.url}/api/analytics?minMultiplier=2`);
      expect(narrowed.status).toBe(200);
      expect(analyticsResponseSchema.parse(await narrowed.json()).dataset.roundsIncluded).toBe(2);
    } finally {
      await limited.close();
    }
  });

  it('refuses a limit above the analytics maximum', () => {
    expect(() => analyticsRouter(db, { maxRounds: MAX_ANALYTICS_ROUNDS + 1 })).toThrow(RangeError);
  });
});
