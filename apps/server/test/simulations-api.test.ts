import { createHash } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import express from 'express';
import type { AddressInfo } from 'node:net';
import type { Server } from 'node:http';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  apiErrorSchema,
  backtestDatasetReportSchema,
  ledgerResponseSchema,
  runBacktest,
  simulationRunDtoSchema,
  simulationRunsListSchema,
  type SimulationRunDto,
} from '@aviator/shared';
import { openDatabase, type Db } from '../src/db/connection.js';
import { migrate } from '../src/db/migrate.js';
import { getOverview } from '../src/db/repositories/overview.js';
import { insertRound } from '../src/db/repositories/rounds.js';
import { createErrorHandler } from '../src/http/errors.js';
import { simulationsRouter } from '../src/http/routes/simulations.js';
import { FAILED_RUN_MESSAGE } from '../src/simulations/service.js';
import { createTestDb, startTestServer } from './helpers.js';

// SYNTHETIC TEST FIXTURES: invented rounds used only to exercise the simulation API.
// Rows inserted with isSynthetic=false exist only in temporary test databases.

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

const SOURCE = 'synthetic-sim';

function at(second: number): string {
  return new Date(Date.UTC(2026, 0, 1, 0, 0, second)).toISOString();
}

function seed(
  target: Db,
  rows: { m: number; eventAt?: string | null; source?: string; synthetic?: boolean }[],
): void {
  for (const r of rows) {
    insertRound(target, {
      multiplierX100: r.m,
      source: r.source ?? SOURCE,
      sourceRoundId: null,
      observedAt: '2026-06-01T00:00:00.000Z',
      eventAt: r.eventAt === undefined ? null : r.eventAt,
      importId: null,
      isSynthetic: r.synthetic ?? false,
    });
  }
}

/** Dated rounds at seconds 0, 1, 2, ... with the given multipliers. */
function seedSeries(target: Db, multipliers: number[], start = 0): void {
  seed(
    target,
    multipliers.map((m, i) => ({ m, eventAt: at(start + i) })),
  );
}

function request(overrides: Record<string, unknown> = {}) {
  return {
    strategy: {
      schemaVersion: 1,
      currency: 'NGN',
      legs: {
        A: { label: 'Leg A', enabled: true, stakeMinor: 100, cashoutTargetX100: 200 },
        B: { label: 'Leg B', enabled: true, stakeMinor: 100, cashoutTargetX100: 600 },
      },
    },
    settings: {
      schemaVersion: 1,
      currency: 'NGN',
      startingBankrollMinor: 1_000,
      insufficientBankrollPolicy: 'skip_leg',
      risk: {
        stopBelowBankrollMinor: null,
        stopAtOrAboveBankrollMinor: null,
        maxDrawdownBps: null,
        maxRounds: null,
      },
    },
    dataset: { source: SOURCE },
    ...overrides,
  };
}

async function post(body: unknown, base = server.baseUrl) {
  return fetch(`${base}/api/simulations`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
}

async function runOk(body: unknown = request(), base = server.baseUrl): Promise<SimulationRunDto> {
  const res = await post(body, base);
  expect(res.status).toBe(201);
  return simulationRunDtoSchema.parse(await res.json());
}

function count(table: string, target = db): number {
  return (target.prepare(`SELECT COUNT(*) AS n FROM ${table}`).get() as { n: number }).n;
}

function roundsSnapshot(target = db): unknown[] {
  return target.prepare('SELECT * FROM rounds ORDER BY id').all();
}

describe('GET /api/simulations/dataset', () => {
  it('requires a source', async () => {
    const res = await fetch(`${server.baseUrl}/api/simulations/dataset`);
    expect(res.status).toBe(400);
  });

  it('reports eligible, undated and synthetic rounds and the ordering rule', async () => {
    seedSeries(db, [150, 250, 700]);
    seed(db, [{ m: 300 }, { m: 300, eventAt: at(50), synthetic: true }]);
    seed(db, [{ m: 999, eventAt: at(99), source: 'other-source' }]);
    const res = await fetch(`${server.baseUrl}/api/simulations/dataset?source=${SOURCE}`);
    expect(res.status).toBe(200);
    const report = backtestDatasetReportSchema.parse(await res.json());
    expect(report).toMatchObject({
      roundsMatching: 4,
      roundsEligible: 3,
      excludedNoEventTime: 1,
      excludedSynthetic: 1,
      duplicateEventTimes: 0,
      firstEventAt: at(0),
      lastEventAt: at(2),
      orderable: true,
      problem: null,
    });
    expect(report.orderingRule).toMatch(/event time ascending/);
  });

  it('applies the event-time range [from, to)', async () => {
    seedSeries(db, [150, 250, 700, 120]);
    const q = new URLSearchParams({ source: SOURCE, eventFrom: at(1), eventTo: at(3) });
    const report = backtestDatasetReportSchema.parse(
      await (await fetch(`${server.baseUrl}/api/simulations/dataset?${q}`)).json(),
    );
    expect(report).toMatchObject({ roundsEligible: 2, firstEventAt: at(1), lastEventAt: at(2) });
  });

  it('flags duplicate event times and undated-only selections as not orderable', async () => {
    seed(db, [
      { m: 150, eventAt: at(0) },
      { m: 250, eventAt: at(0) },
    ]);
    let report = backtestDatasetReportSchema.parse(
      await (await fetch(`${server.baseUrl}/api/simulations/dataset?source=${SOURCE}`)).json(),
    );
    expect(report).toMatchObject({ orderable: false, duplicateEventTimes: 1 });
    expect(report.problem).toMatch(/ambiguous/);

    seed(db, [{ m: 150, source: 'undated-only' }]);
    report = backtestDatasetReportSchema.parse(
      await (await fetch(`${server.baseUrl}/api/simulations/dataset?source=undated-only`)).json(),
    );
    expect(report).toMatchObject({ orderable: false, roundsEligible: 0, excludedNoEventTime: 1 });
  });

  it('rejects unknown parameters, including multiplier filters', async () => {
    const res = await fetch(
      `${server.baseUrl}/api/simulations/dataset?source=${SOURCE}&minMultiplier=2`,
    );
    expect(res.status).toBe(400);
  });
});

describe('POST /api/simulations', () => {
  it('runs, stores and returns a completed backtest that matches the engine', async () => {
    seedSeries(db, [150, 200, 700]);
    const before = roundsSnapshot();
    const run = await runOk();
    expect(run.status).toBe('completed');
    expect(run.summary).toMatchObject({
      roundsReplayed: 3,
      endingBankrollMinor: 1_400,
      totalStakedMinor: 600,
      totalReturnedMinor: 1_000,
      netProfitMinor: 400,
      stopReason: 'completed_all_rounds',
    });
    expect(run.dataset).toMatchObject({ roundsEligible: 3, orderable: true });
    expect(run.datasetSha256).toMatch(/^[0-9a-f]{64}$/);
    // The stored summary is exactly the engine's output for the same ordered rounds.
    const ids = (db.prepare('SELECT id FROM rounds ORDER BY id').all() as { id: number }[]).map(
      (r) => r.id,
    );
    const expected = runBacktest(
      [150, 200, 700].map((m, i) => ({ roundId: ids[i]!, multiplierX100: m, eventAt: at(i) })),
      run.strategy,
      run.settings,
    );
    expect(run.summary).toEqual(expected.summary);
    // Ledger: one entry per placed leg per round; historical rounds untouched.
    expect(count('ledger_entries')).toBe(6);
    expect(roundsSnapshot()).toEqual(before);
    expect(getOverview(db, 'NGN').latestVirtualBankroll).toMatchObject({
      endingBankrollMinor: 1_400,
    });
  });

  it('replays in event-time order, not insertion order', async () => {
    seed(db, [
      { m: 700, eventAt: at(2) },
      { m: 150, eventAt: at(0) },
      { m: 200, eventAt: at(1) },
    ]);
    const run = await runOk();
    const ledger = ledgerResponseSchema.parse(
      await (await fetch(`${server.baseUrl}/api/simulations/${run.id}/ledger`)).json(),
    );
    expect(ledger.rounds.map((r) => r.multiplierX100)).toEqual([150, 200, 700]);
    expect(ledger.rounds.map((r) => r.eventAt)).toEqual([at(0), at(1), at(2)]);
  });

  it('excludes synthetic and undated rounds from the replay', async () => {
    seedSeries(db, [150, 200]);
    seed(db, [{ m: 5_000 }, { m: 5_000, eventAt: at(10), synthetic: true }]);
    const run = await runOk();
    expect(run.summary!.roundsReplayed).toBe(2);
    expect(run.dataset).toMatchObject({ excludedNoEventTime: 1, excludedSynthetic: 1 });
  });

  it('is reproducible: rerunning the same request gives the same hash and summary', async () => {
    seedSeries(db, [150, 230, 610, 100, 990, 205]);
    const first = await runOk();
    const second = await runOk();
    expect(second.id).not.toBe(first.id);
    expect(second.datasetSha256).toBe(first.datasetSha256);
    expect(second.summary).toEqual(first.summary);
    // A new round changes the dataset hash.
    seedSeries(db, [300], 100);
    const third = await runOk();
    expect(third.datasetSha256).not.toBe(first.datasetSha256);
  });

  it('records the stop reason and only the replayed rounds in the ledger', async () => {
    seedSeries(db, [100, 100, 100, 100]);
    const run = await runOk(
      request({
        settings: { ...request().settings, risk: { ...request().settings.risk, maxRounds: 2 } },
      }),
    );
    expect(run.summary).toMatchObject({ stopReason: 'max_rounds', roundsReplayed: 2 });
    expect(count('ledger_entries')).toBe(4);
  });

  it('rejects datasets that cannot be ordered with 422 and stores nothing', async () => {
    seed(db, [
      { m: 150, eventAt: at(0) },
      { m: 250, eventAt: at(0) },
    ]);
    const res = await post(request());
    expect(res.status).toBe(422);
    const body = apiErrorSchema.parse(await res.json());
    expect(body.error.code).toBe('dataset_not_replayable');
    expect(count('simulation_runs')).toBe(0);

    const empty = await post(request({ dataset: { source: 'nothing-here' } }));
    expect(empty.status).toBe(422);
    expect(count('simulation_runs')).toBe(0);
  });

  it('rejects selections larger than the configured maximum with 422', async () => {
    const app = express();
    app.use(express.json());
    app.use('/api', simulationsRouter(db, { log: () => {}, maxRounds: 2 }));
    app.use(createErrorHandler(() => {}));
    const small: Server = await new Promise((resolve) => {
      const s = app.listen(0, '127.0.0.1', () => resolve(s));
    });
    try {
      seedSeries(db, [150, 200, 700]);
      const res = await post(
        request(),
        `http://127.0.0.1:${(small.address() as AddressInfo).port}`,
      );
      expect(res.status).toBe(422);
      expect(apiErrorSchema.parse(await res.json()).error.message).toMatch(/at most 2/);
    } finally {
      await new Promise((resolve) => small.close(resolve));
    }
  });

  it('rejects a strategy with no enabled legs', async () => {
    seedSeries(db, [150]);
    const base = request();
    const res = await post({
      ...base,
      strategy: {
        ...base.strategy,
        legs: {
          A: { ...base.strategy.legs.A, enabled: false },
          B: { ...base.strategy.legs.B, enabled: false },
        },
      },
    });
    expect(res.status).toBe(400);
    expect(count('simulation_runs')).toBe(0);
  });

  it('validates the request strictly', async () => {
    seedSeries(db, [150]);
    const base = request();
    const bad: unknown[] = [
      {},
      { ...base, extra: true },
      { ...base, dataset: {} },
      { ...base, dataset: { source: SOURCE, minMultiplier: 2 } },
      { ...base, settings: { ...base.settings, currency: 'USD' } },
      { ...base, settings: { ...base.settings, startingBankrollMinor: 50 } },
      {
        ...base,
        strategy: {
          ...base.strategy,
          legs: { ...base.strategy.legs, A: { ...base.strategy.legs.A, cashoutTargetX100: 100 } },
        },
      },
      {
        ...base,
        strategy: {
          ...base.strategy,
          legs: { ...base.strategy.legs, A: { ...base.strategy.legs.A, stakeMinor: 1.5 } },
        },
      },
    ];
    for (const body of bad) {
      const res = await post(body);
      expect(res.status, JSON.stringify(body)).toBe(400);
      expect(apiErrorSchema.parse(await res.json()).error.code).toBe('validation_error');
    }
    expect(count('simulation_runs')).toBe(0);
  });

  it('rolls back a failed write, records a failed run without a ledger and leaks nothing', async () => {
    seedSeries(db, [150, 200, 700]);
    const before = roundsSnapshot();
    // Inject a failure part-way through the ledger write.
    db.exec(`CREATE TRIGGER fail_ledger BEFORE INSERT ON ledger_entries WHEN NEW.sequence_no = 2
             BEGIN SELECT RAISE(ABORT, 'injected test failure'); END;`);
    const res = await post(request());
    expect(res.status).toBe(500);
    const body = apiErrorSchema.parse(await res.json());
    expect(body.error).toEqual({ code: 'simulation_failed', message: FAILED_RUN_MESSAGE });
    expect(JSON.stringify(body)).not.toMatch(/injected/);
    expect(logged).toHaveLength(1);

    expect(count('ledger_entries')).toBe(0);
    const runs = db
      .prepare('SELECT status, summary_json, ending_bankroll_minor FROM simulation_runs')
      .all();
    expect(runs).toEqual([{ status: 'failed', summary_json: null, ending_bankroll_minor: null }]);
    expect(roundsSnapshot()).toEqual(before);

    const list = simulationRunsListSchema.parse(
      await (await fetch(`${server.baseUrl}/api/simulations`)).json(),
    );
    expect(list.items).toHaveLength(1);
    expect(list.items[0]).toMatchObject({
      status: 'failed',
      summary: null,
      errorMessage: FAILED_RUN_MESSAGE,
    });
    expect(getOverview(db, 'NGN').latestVirtualBankroll).toBeNull();
  });
});

describe('reading runs', () => {
  it('lists runs newest first with pagination', async () => {
    seedSeries(db, [150, 200]);
    const a = await runOk();
    const b = await runOk();
    const list = simulationRunsListSchema.parse(
      await (await fetch(`${server.baseUrl}/api/simulations?limit=1`)).json(),
    );
    expect(list).toMatchObject({ total: 2, limit: 1, offset: 0 });
    expect(list.items.map((r) => r.id)).toEqual([b.id]);
    const one = simulationRunDtoSchema.parse(
      await (await fetch(`${server.baseUrl}/api/simulations/${a.id}`)).json(),
    );
    expect(one).toEqual(a);
  });

  it('pages the ledger by round', async () => {
    seedSeries(db, [150, 200, 700, 120, 650]);
    const run = await runOk(
      request({
        strategy: {
          ...request().strategy,
          legs: { ...request().strategy.legs, B: { ...request().strategy.legs.B, enabled: false } },
        },
      }),
    );
    const page = ledgerResponseSchema.parse(
      await (
        await fetch(`${server.baseUrl}/api/simulations/${run.id}/ledger?limit=2&offset=2`)
      ).json(),
    );
    expect(page).toMatchObject({ totalRounds: 5, limit: 2, offset: 2 });
    expect(page.rounds.map((r) => r.sequenceNo)).toEqual([2, 3]);
    expect(page.rounds[0]).toMatchObject({ multiplierX100: 700, roundNetMinor: 100 });
    expect(page.rounds[0]!.legs).toEqual([
      {
        leg: 'A',
        result: 'win',
        stakeMinor: 100,
        cashoutTargetX100: 200,
        grossReturnMinor: 200,
        netMinor: 100,
      },
    ]);
    for (const r of page.rounds) {
      expect(r.bankrollAfterMinor - r.bankrollBeforeMinor).toBe(r.roundNetMinor);
    }
  });

  it('returns 404 for unknown or malformed ids and 400 for bad pagination', async () => {
    for (const id of ['999', 'abc', '0', '-1']) {
      expect((await fetch(`${server.baseUrl}/api/simulations/${id}`)).status).toBe(404);
      expect((await fetch(`${server.baseUrl}/api/simulations/${id}/ledger`)).status).toBe(404);
    }
    expect((await fetch(`${server.baseUrl}/api/simulations?limit=1000`)).status).toBe(400);
    expect((await fetch(`${server.baseUrl}/api/simulations?bogus=1`)).status).toBe(400);
  });
});

describe('persistence', () => {
  it('keeps completed runs and ledgers after the database is reopened', async () => {
    const dir = mkdtempSync(path.join(tmpdir(), 'aviator-sim-'));
    const file = path.join(dir, 'test.sqlite');
    try {
      const first = openDatabase(file);
      migrate(first);
      seedSeries(first, [150, 200, 700]);
      const s1 = await startTestServer(first);
      const run = await runOk(request(), s1.baseUrl);
      await s1.close();
      first.close();

      const reopened = openDatabase(file);
      migrate(reopened);
      const s2 = await startTestServer(reopened);
      try {
        const again = simulationRunDtoSchema.parse(
          await (await fetch(`${s2.baseUrl}/api/simulations/${run.id}`)).json(),
        );
        expect(again).toEqual(run);
        const ledger = ledgerResponseSchema.parse(
          await (await fetch(`${s2.baseUrl}/api/simulations/${run.id}/ledger`)).json(),
        );
        expect(ledger.rounds).toHaveLength(3);
        expect(count('ledger_entries', reopened)).toBe(6);
      } finally {
        await s2.close();
        reopened.close();
      }
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe('review regressions', () => {
  it('refuses a run whose exact results would exceed the safe integer range (422, nothing stored)', async () => {
    seedSeries(db, [100_000_000]);
    const base = request();
    const res = await post({
      ...base,
      strategy: {
        ...base.strategy,
        legs: {
          A: { ...base.strategy.legs.A, stakeMinor: 1e12, cashoutTargetX100: 100_000_000 },
          B: { ...base.strategy.legs.B, enabled: false },
        },
      },
      settings: { ...base.settings, startingBankrollMinor: 1e12 },
    });
    expect(res.status).toBe(422);
    expect(apiErrorSchema.parse(await res.json()).error.code).toBe('simulation_out_of_range');
    expect(count('simulation_runs')).toBe(0);
    expect(count('ledger_entries')).toBe(0);
  });

  it('accepts only plain decimal run ids', async () => {
    seedSeries(db, [150, 200]);
    const run = await runOk();
    expect(run.id).toBe(1);
    for (const id of ['1e0', '0x1', '+1', '1.0', ' 1', '01']) {
      const res = await fetch(`${server.baseUrl}/api/simulations/${encodeURIComponent(id)}`);
      expect(res.status, id).toBe(404);
    }
  });

  it('refuses event times stored in a non-canonical form (ordering would be unreliable)', async () => {
    seedSeries(db, [150, 200]);
    // Written directly, bypassing the application's normalisation.
    db.prepare(
      `INSERT INTO rounds (multiplier_x100, source, observed_at, event_at, is_synthetic)
       VALUES (300, ?, '2026-06-01T00:00:00.000Z', '2026-01-01T00:00:05Z', 0)`,
    ).run(SOURCE);
    const report = backtestDatasetReportSchema.parse(
      await (await fetch(`${server.baseUrl}/api/simulations/dataset?source=${SOURCE}`)).json(),
    );
    expect(report).toMatchObject({ orderable: false, nonCanonicalEventTimes: 1 });
    const res = await post(request());
    expect(res.status).toBe(422);
    expect(count('simulation_runs')).toBe(0);
  });

  it('fingerprints the documented canonical encoding, including source and source round ids', async () => {
    seed(db, [
      { m: 150, eventAt: at(0) },
      { m: 200, eventAt: at(1) },
    ]);
    db.prepare('UPDATE rounds SET source_round_id = ? WHERE id = 1').run('r,1\n');
    const run = await runOk();
    const lines = [
      'aviator-intelligence/backtest-dataset/v1',
      JSON.stringify(SOURCE),
      JSON.stringify([1, 'r,1\n', 150, at(0)]),
      JSON.stringify([2, null, 200, at(1)]),
    ];
    const expected = createHash('sha256')
      .update(lines.map((l) => `${l}\n`).join(''))
      .digest('hex');
    expect(run.datasetSha256).toBe(expected);
  });

  it('keeps a stored ledger immutable and a completed run completed', async () => {
    seedSeries(db, [150, 200]);
    const run = await runOk();
    expect(() => db.prepare('UPDATE ledger_entries SET net_minor = net_minor').run()).toThrow(
      /immutable/,
    );
    expect(() =>
      db
        .prepare(
          `UPDATE simulation_runs SET status = 'failed', summary_json = NULL, stop_reason = NULL,
             ending_bankroll_minor = NULL, rounds_processed = NULL WHERE id = ?`,
        )
        .run(run.id),
    ).toThrow(/completed simulation run cannot change status/);
  });
});
