import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  apiErrorSchema,
  BOOTSTRAP_ALGORITHM_VERSION,
  maxPathsForSample,
  runBootstrap,
  simulationAnalysesListSchema,
  simulationAnalysisDtoSchema,
  simulationRunDtoSchema,
  type SimulationAnalysisDto,
  type SimulationRunDto,
} from '@aviator/shared';
import { openDatabase, type Db } from '../src/db/connection.js';
import { migrate } from '../src/db/migrate.js';
import { MIGRATIONS } from '../src/db/migrations/index.js';
import { insertRound } from '../src/db/repositories/rounds.js';
import { FAILED_ANALYSIS_MESSAGE } from '../src/simulations/analysis.js';
import { createTestDb, startTestServer } from './helpers.js';

// SYNTHETIC TEST FIXTURES: invented rounds used only to exercise the analysis API.
// Rows inserted with isSynthetic=false exist only in temporary in-memory test databases.

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

const SOURCE = 'synthetic-uncertainty';
const MULTIPLIERS = [150, 200, 700, 100, 990, 205, 120, 340, 600, 110, 101, 2_500];
const at = (second: number) => new Date(Date.UTC(2026, 0, 1) + second * 1000).toISOString();

function seed(
  target: Db,
  rows: {
    m: number;
    eventAt?: string | null;
    source?: string;
    synthetic?: boolean;
    importId?: number | null;
  }[],
): void {
  for (const r of rows) {
    insertRound(target, {
      multiplierX100: r.m,
      source: r.source ?? SOURCE,
      sourceRoundId: null,
      observedAt: '2026-06-01T00:00:00.000Z',
      eventAt: r.eventAt === undefined ? null : r.eventAt,
      importId: r.importId ?? null,
      isSynthetic: r.synthetic ?? false,
    });
  }
}

const seedSeries = (target: Db, ms: number[], start = 0) =>
  seed(
    target,
    ms.map((m, i) => ({ m, eventAt: at(start + i) })),
  );

function backtestRequest(overrides: Record<string, unknown> = {}) {
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
        stopBelowBankrollMinor: 600,
        stopAtOrAboveBankrollMinor: null,
        maxDrawdownBps: null,
        maxRounds: null,
      },
    },
    dataset: { source: SOURCE },
    ...overrides,
  };
}

const json = (body: unknown) => ({
  method: 'POST',
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify(body),
});

async function createRun(
  body: unknown = backtestRequest(),
  base = server.baseUrl,
): Promise<SimulationRunDto> {
  const res = await fetch(`${base}/api/simulations`, json(body));
  expect(res.status).toBe(201);
  return simulationRunDtoSchema.parse(await res.json());
}

const analyse = (runId: number, body: unknown, base = server.baseUrl) =>
  fetch(`${base}/api/simulations/${runId}/analyses`, json(body));

async function analyseOk(
  runId: number,
  body: unknown = { paths: 300, seed: 42 },
  base = server.baseUrl,
): Promise<SimulationAnalysisDto> {
  const res = await analyse(runId, body, base);
  expect(res.status, await res.clone().text()).toBe(201);
  return simulationAnalysisDtoSchema.parse(await res.json());
}

const count = (table: string, target = db) =>
  (target.prepare(`SELECT COUNT(*) AS n FROM ${table}`).get() as { n: number }).n;

describe('POST /api/simulations/:id/analyses', () => {
  it('resamples exactly the run sample through the shared engine and stores the result', async () => {
    seedSeries(db, MULTIPLIERS);
    const run = await createRun();
    const analysis = await analyseOk(run.id);
    expect(analysis).toMatchObject({
      simulationRunId: run.id,
      status: 'completed',
      algorithmVersion: BOOTSTRAP_ALGORITHM_VERSION,
      seed: 42,
      paths: 300,
      datasetSha256: run.datasetSha256,
    });
    // Identical to the shared engine run on the same sample and configuration.
    const expected = runBootstrap(
      MULTIPLIERS,
      run.strategy,
      run.settings,
      { paths: 300, seed: 42 },
      run.summary!,
    );
    expect(analysis.summary).toEqual(expected);
    expect(analysis.summary.sample.size).toBe(MULTIPLIERS.length);
    expect(analysis.summary.observed).toMatchObject({
      endingBankrollMinor: run.summary!.endingBankrollMinor,
      stopReason: run.summary!.stopReason,
      denominator: 300,
    });
    expect(analysis.summary.configuredBoundaries.lowerBankrollStop).toMatchObject({
      thresholdMinor: 600,
      denominator: 300,
    });
    expect(analysis.summary.configuredBoundaries.maxDrawdownStop).toBeNull();
    expect(count('simulation_analyses')).toBe(1);
  });

  it('reproduces identical results for the same seed and differs for another', async () => {
    seedSeries(db, MULTIPLIERS);
    const run = await createRun();
    const a = await analyseOk(run.id, { paths: 200, seed: 7 });
    const b = await analyseOk(run.id, { paths: 200, seed: 7 });
    const c = await analyseOk(run.id, { paths: 200, seed: 8 });
    expect(b.id).not.toBe(a.id);
    expect(b.summary).toEqual(a.summary);
    expect(c.summary.endingBankrollMinor).not.toEqual(a.summary.endingBankrollMinor);
  });

  it('excludes synthetic and undated rounds and isolates source, import and date range', async () => {
    seedSeries(db, MULTIPLIERS);
    seed(db, [
      { m: 50_000, eventAt: at(100), synthetic: true },
      { m: 50_000 }, // undated
      { m: 50_000, eventAt: at(200), source: 'synthetic-other-source' },
    ]);
    const run = await createRun();
    const analysis = await analyseOk(run.id);
    expect(analysis.summary.sample).toMatchObject({ size: 12, maxMultiplierX100: 2_500 });

    // Date range: only the first five rounds.
    const ranged = await createRun(
      backtestRequest({ dataset: { source: SOURCE, eventFrom: at(0), eventTo: at(5) } }),
    );
    const rangedAnalysis = await analyseOk(ranged.id);
    expect(rangedAnalysis.summary.sample).toMatchObject({
      size: 5,
      minMultiplierX100: 100,
      maxMultiplierX100: 990,
    });

    // Import: only rounds of import 1.
    db.prepare(
      `INSERT INTO data_imports (id, source_description, source_kind, status, records_total,
         records_accepted, records_rejected, records_duplicate, imported_at)
       VALUES (1, ?, 'file_import', 'completed', 2, 2, 0, 0, '2026-01-01T00:00:00.000Z')`,
    ).run(SOURCE);
    seed(db, [
      { m: 333, eventAt: at(300), importId: 1 },
      { m: 444, eventAt: at(301), importId: 1 },
    ]);
    const imported = await createRun(backtestRequest({ dataset: { source: SOURCE, importId: 1 } }));
    const importedAnalysis = await analyseOk(imported.id);
    expect(importedAnalysis.summary.sample).toMatchObject({
      size: 2,
      minMultiplierX100: 333,
      maxMultiplierX100: 444,
    });
  });

  it('refuses when the run sample has changed since it ran (409), storing nothing', async () => {
    seedSeries(db, MULTIPLIERS);
    const run = await createRun();
    seedSeries(db, [250], 50); // a new eligible round changes the sample
    const res = await analyse(run.id, { paths: 50, seed: 1 });
    expect(res.status).toBe(409);
    expect(apiErrorSchema.parse(await res.json()).error.code).toBe('dataset_changed');
    expect(count('simulation_analyses')).toBe(0);
  });

  it('refuses failed runs (409) and unknown runs (404)', async () => {
    seedSeries(db, MULTIPLIERS);
    db.exec(`CREATE TRIGGER fail_ledger BEFORE INSERT ON ledger_entries
             BEGIN SELECT RAISE(ABORT, 'injected'); END;`);
    expect((await fetch(`${server.baseUrl}/api/simulations`, json(backtestRequest()))).status).toBe(
      500,
    );
    db.exec('DROP TRIGGER fail_ledger');
    const failedId = (
      db.prepare("SELECT id FROM simulation_runs WHERE status = 'failed'").get() as {
        id: number;
      }
    ).id;
    const res = await analyse(failedId, { paths: 10, seed: 1 });
    expect(res.status).toBe(409);
    expect(apiErrorSchema.parse(await res.json()).error.code).toBe('run_not_analyzable');
    expect((await analyse(999, { paths: 10, seed: 1 })).status).toBe(404);
    expect((await analyse(0, { paths: 10, seed: 1 })).status).toBe(404);
    expect(count('simulation_analyses')).toBe(0);
  });

  it('validates seeds and settings strictly (400), storing nothing', async () => {
    seedSeries(db, MULTIPLIERS);
    const run = await createRun();
    for (const body of [
      {},
      { paths: 10 },
      { seed: 1 },
      { paths: 0, seed: 1 },
      { paths: 2_001, seed: 1 },
      { paths: 1.5, seed: 1 },
      { paths: 10, seed: -1 },
      { paths: 10, seed: 0.5 },
      { paths: 10, seed: 2 ** 53 },
      { paths: 10, seed: '7' },
      { paths: 10, seed: 1, extra: true },
    ]) {
      const res = await analyse(run.id, body);
      expect(res.status, JSON.stringify(body)).toBe(400);
      expect(apiErrorSchema.parse(await res.json()).error.code).toBe('validation_error');
    }
    expect(count('simulation_analyses')).toBe(0);
  });

  it('refuses work beyond the limit before computing (422) and reports the allowed maximum', async () => {
    seedSeries(
      db,
      Array.from({ length: 2_500 }, (_, i) => 100 + (i % 700)),
    );
    const run = await createRun();
    const maxPaths = maxPathsForSample(2_500);
    expect(maxPaths).toBe(800);
    const list = simulationAnalysesListSchema.parse(
      await (await fetch(`${server.baseUrl}/api/simulations/${run.id}/analyses`)).json(),
    );
    expect(list).toMatchObject({ maxPaths: 800, sampleSize: 2_500, total: 0 });
    const res = await analyse(run.id, { paths: 801, seed: 1 });
    expect(res.status).toBe(422);
    const body = apiErrorSchema.parse(await res.json());
    expect(body.error).toMatchObject({
      code: 'analysis_too_large',
      details: { maxPaths: 800, sampleSize: 2_500 },
    });
    expect(count('simulation_analyses')).toBe(0);
  });

  it('refuses results beyond the exact integer range (422) instead of storing rounded figures', async () => {
    // Historically the first round loses everything, so the 1,000,000x round is never
    // settled; resampled paths that draw it first would exceed the exact range.
    seed(db, [
      { m: 100, eventAt: at(0) },
      { m: 100_000_000, eventAt: at(1) },
    ]);
    const base = backtestRequest();
    const run = await createRun({
      ...base,
      strategy: {
        ...base.strategy,
        legs: {
          A: { ...base.strategy.legs.A, stakeMinor: 1e12, cashoutTargetX100: 100_000_000 },
          B: { ...base.strategy.legs.B, enabled: false },
        },
      },
      settings: {
        ...base.settings,
        startingBankrollMinor: 1e12,
        risk: { ...base.settings.risk, stopBelowBankrollMinor: null },
      },
    });
    expect(run.summary!.stopReason).toBe('bankroll_exhausted');
    const res = await analyse(run.id, { paths: 50, seed: 1 });
    expect(res.status).toBe(422);
    expect(apiErrorSchema.parse(await res.json()).error.code).toBe('simulation_out_of_range');
    expect(count('simulation_analyses')).toBe(0);
  });

  it('stores nothing when the write fails, with a generic 500 that leaks no internals', async () => {
    seedSeries(db, MULTIPLIERS);
    const run = await createRun();
    db.exec(`CREATE TRIGGER fail_analysis BEFORE INSERT ON simulation_analyses
             BEGIN SELECT RAISE(ABORT, 'injected analysis failure'); END;`);
    const res = await analyse(run.id, { paths: 50, seed: 1 });
    expect(res.status).toBe(500);
    const body = apiErrorSchema.parse(await res.json());
    expect(body.error).toEqual({ code: 'analysis_failed', message: FAILED_ANALYSIS_MESSAGE });
    expect(JSON.stringify(body)).not.toMatch(/injected|SQLITE|simulation_analyses/);
    expect(logged).toHaveLength(1);
    expect(count('simulation_analyses')).toBe(0);
  });
});

describe('reading analyses', () => {
  it('lists newest first and returns one analysis, scoped to its run', async () => {
    seedSeries(db, MULTIPLIERS);
    const run = await createRun();
    const other = await createRun();
    const a = await analyseOk(run.id, { paths: 20, seed: 1 });
    const b = await analyseOk(run.id, { paths: 20, seed: 2 });
    const list = simulationAnalysesListSchema.parse(
      await (await fetch(`${server.baseUrl}/api/simulations/${run.id}/analyses?limit=1`)).json(),
    );
    expect(list).toMatchObject({ total: 2, sampleSize: 12, maxPaths: 2_000 });
    expect(list.items.map((i) => i.id)).toEqual([b.id]);
    const one = simulationAnalysisDtoSchema.parse(
      await (await fetch(`${server.baseUrl}/api/simulations/${run.id}/analyses/${a.id}`)).json(),
    );
    expect(one).toEqual(a);
    for (const path of [
      `/api/simulations/${other.id}/analyses/${a.id}`,
      `/api/simulations/${run.id}/analyses/999`,
      `/api/simulations/${run.id}/analyses/1e0`,
    ]) {
      expect((await fetch(`${server.baseUrl}${path}`)).status, path).toBe(404);
    }
    expect(
      (await fetch(`${server.baseUrl}/api/simulations/${run.id}/analyses?limit=51`)).status,
    ).toBe(400);
  });

  it('reports an unreadable stored analysis as a server-side error', async () => {
    seedSeries(db, MULTIPLIERS);
    const run = await createRun();
    const id = Number(
      db
        .prepare(
          `INSERT INTO simulation_analyses (simulation_run_id, status, method, algorithm_version,
             seed, paths, sample_size, dataset_sha256, config_json, summary_json, created_at,
             completed_at)
           VALUES (?, 'completed', 'iid_bootstrap', 'v0', 1, 1, 1, ?, '{}', '{}', 'x', 'x')`,
        )
        .run(run.id, run.datasetSha256).lastInsertRowid,
    );
    for (const path of [
      `/api/simulations/${run.id}/analyses`,
      `/api/simulations/${run.id}/analyses/${id}`,
    ]) {
      const res = await fetch(`${server.baseUrl}${path}`);
      expect(res.status, path).toBe(500);
      const body = apiErrorSchema.parse(await res.json());
      expect(body.error).toMatchObject({
        code: 'stored_data_invalid',
        details: { simulationRunId: run.id, simulationAnalysisId: id },
      });
    }
  });
});

describe('simulation_analyses integrity', () => {
  it('enforces completed runs, matching fingerprints, immutability and cascade', async () => {
    seedSeries(db, MULTIPLIERS);
    const run = await createRun();
    const analysis = await analyseOk(run.id, { paths: 20, seed: 1 });
    const insert = (runId: number, sha: string) =>
      db
        .prepare(
          `INSERT INTO simulation_analyses (simulation_run_id, status, method, algorithm_version,
             seed, paths, sample_size, dataset_sha256, config_json, summary_json, created_at,
             completed_at)
           VALUES (?, 'completed', 'iid_bootstrap', 'v1', 1, 1, 1, ?, '{}', '{}', 'x', 'x')`,
        )
        .run(runId, sha);
    expect(() => insert(run.id, 'b'.repeat(64))).toThrow(/same dataset fingerprint/);
    expect(() => insert(999, run.datasetSha256!)).toThrow(/completed run/);
    expect(() =>
      db
        .prepare(
          `INSERT INTO simulation_analyses (simulation_run_id, status, method, algorithm_version,
             seed, paths, sample_size, dataset_sha256, config_json, summary_json, created_at,
             completed_at)
           VALUES (?, 'running', 'iid_bootstrap', 'v1', 1, 1, 1, ?, '{}', '{}', 'x', 'x')`,
        )
        .run(run.id, run.datasetSha256),
    ).toThrow(/CHECK/);
    expect(() => db.prepare('UPDATE simulation_analyses SET seed = 2').run()).toThrow(/immutable/);
    expect(count('simulation_analyses')).toBe(1);
    db.prepare('DELETE FROM simulation_runs WHERE id = ?').run(run.id);
    expect(count('simulation_analyses')).toBe(0);
    expect(count('ledger_entries')).toBe(0);
    expect(analysis.id).toBeGreaterThan(0);
  });

  it('migrates a database holding 001-003 data and analyses its existing runs', async () => {
    const legacy = openDatabase(':memory:');
    migrate(legacy, MIGRATIONS.slice(0, 3));
    seedSeries(legacy, MULTIPLIERS);
    const legacyServer = await startTestServer(legacy);
    try {
      const run = await createRun(backtestRequest(), legacyServer.baseUrl);
      const before = {
        rounds: legacy.prepare('SELECT * FROM rounds ORDER BY id').all(),
        runs: legacy.prepare('SELECT * FROM simulation_runs ORDER BY id').all(),
        ledger: legacy.prepare('SELECT * FROM ledger_entries ORDER BY id').all(),
      };
      expect(migrate(legacy)).toEqual({ applied: [4], currentVersion: 4 });
      expect(legacy.prepare('SELECT * FROM rounds ORDER BY id').all()).toEqual(before.rounds);
      expect(legacy.prepare('SELECT * FROM simulation_runs ORDER BY id').all()).toEqual(
        before.runs,
      );
      expect(legacy.prepare('SELECT * FROM ledger_entries ORDER BY id').all()).toEqual(
        before.ledger,
      );
      const analysis = await analyseOk(run.id, { paths: 20, seed: 3 }, legacyServer.baseUrl);
      expect(analysis.datasetSha256).toBe(run.datasetSha256);
    } finally {
      await legacyServer.close();
      legacy.close();
    }
  });
});
