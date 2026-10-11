import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  apiErrorSchema,
  healthResponseSchema,
  metaResponseSchema,
  overviewResponseSchema,
  roundsListResponseSchema,
} from '@aviator/shared';
import type { Db } from '../src/db/connection.js';
import { MIGRATIONS } from '../src/db/migrations/index.js';
import { createTestDb, startTestServer } from './helpers.js';

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

const get = (path: string) => fetch(`${server.baseUrl}${path}`);

describe('GET /api/health', () => {
  it('reports ok with the schema version', async () => {
    const res = await get('/api/health');
    expect(res.status).toBe(200);
    const body = healthResponseSchema.parse(await res.json());
    expect(body.status).toBe('ok');
    expect(body.database).toEqual({ status: 'ok', schemaVersion: MIGRATIONS.length });
    expect(res.headers.get('x-powered-by')).toBeNull();
    expect(res.headers.get('x-content-type-options')).toBe('nosniff');
  });

  it('reports degraded with 503 when the database is unavailable', async () => {
    db.close();
    const res = await get('/api/health');
    expect(res.status).toBe(503);
    const body = healthResponseSchema.parse(await res.json());
    expect(body.status).toBe('degraded');
    expect(body.database.status).toBe('error');
  });
});

describe('GET /api/meta', () => {
  it('states research mode, no live connection and no real-money execution', async () => {
    const body = metaResponseSchema.parse(await (await get('/api/meta')).json());
    expect(body.mode).toBe('research_simulation');
    expect(body.liveObservation.status).toBe('not_connected');
    expect(body.realMoneyExecution).toBe('not_supported');
  });
});

describe('GET /api/overview', () => {
  it('returns empty, unfabricated figures for a new database', async () => {
    const body = overviewResponseSchema.parse(await (await get('/api/overview')).json());
    expect(body.rounds.total).toBe(0);
    expect(body.simulations.total).toBe(0);
    expect(body.latestVirtualBankroll).toBeNull();
  });
});

describe('GET /api/rounds', () => {
  it('returns an empty list with defaults', async () => {
    const res = await get('/api/rounds');
    expect(res.status).toBe(200);
    expect(roundsListResponseSchema.parse(await res.json())).toEqual({
      items: [],
      total: 0,
      limit: 50,
      offset: 0,
    });
  });

  it.each(['?limit=0', '?limit=201', '?limit=abc', '?offset=-1', '?unexpected=1'])(
    'rejects invalid query %s with a 400 validation error',
    async (query) => {
      const res = await get(`/api/rounds${query}`);
      expect(res.status).toBe(400);
      const body = apiErrorSchema.parse(await res.json());
      expect(body.error.code).toBe('validation_error');
    },
  );
});

describe('error handling', () => {
  it('returns JSON 404 for unknown routes', async () => {
    const res = await get('/api/does-not-exist');
    expect(res.status).toBe(404);
    expect(apiErrorSchema.parse(await res.json()).error.code).toBe('not_found');
  });

  it('exposes only the documented write endpoints', async () => {
    const post = (path: string) =>
      fetch(`${server.baseUrl}${path}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: '{}',
      });
    // Only POST /api/rounds, /api/imports/preview and /api/imports accept writes.
    for (const path of [
      '/api/overview',
      '/api/strategies',
      '/api/simulations',
      '/api/meta',
      '/api/sql',
    ]) {
      expect((await post(path)).status).toBe(404);
    }
  });

  it('returns a generic 500 without leaking internals', async () => {
    db.exec('DROP TABLE ledger_entries; DROP TABLE simulation_runs;');
    const logged: unknown[] = [];
    await server.close();
    server = await startTestServer(db, (_m, e) => logged.push(e));
    const res = await get('/api/overview');
    expect(res.status).toBe(500);
    const body = apiErrorSchema.parse(await res.json());
    expect(body.error).toEqual({ code: 'internal_error', message: 'An unexpected error occurred' });
    expect(logged).toHaveLength(1);
  });
});
