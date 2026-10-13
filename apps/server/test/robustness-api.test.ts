import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  apiErrorSchema,
  backtestRequestSchema,
  ROBUSTNESS_ALGORITHM_VERSION,
  ROBUSTNESS_RESULT_SCHEMA_VERSION,
  robustnessAnalysesListSchema,
  robustnessAnalysisDtoSchema,
  runBlockRobustness,
  simulationRunDtoSchema,
  type RobustnessAnalysisDto,
  type SimulationRunDto,
} from '@aviator/shared';
import { openDatabase, type Db } from '../src/db/connection.js';
import { migrate } from '../src/db/migrate.js';
import { MIGRATIONS } from '../src/db/migrations/index.js';
import { insertRound } from '../src/db/repositories/rounds.js';
import { getRun, loadReplayRounds } from '../src/db/repositories/simulations.js';
import { HttpError } from '../src/http/errors.js';
import { FAILED_ROBUSTNESS_MESSAGE, runAndStoreRobustness } from '../src/simulations/robustness.js';
import {
  createTestDb,
  insertLegacyRun,
  MIGRATION_006_RUN_COLUMNS,
  startTestServer,
  withoutColumns,
} from './helpers.js';

// SYNTHETIC TEST FIXTURES: invented rounds used only to exercise the robustness API.
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

const SOURCE = 'synthetic-robustness';
const at = (second: number) => new Date(Date.UTC(2026, 0, 1) + second * 1000).toISOString();
const multipliers = (n: number) =>
  Array.from({ length: n }, (_, i) => [150, 200, 700, 100, 990, 205, 120, 340, 600, 110][i % 10]!);

function seedSeries(target: Db, ms: number[], start = 0, extra: { synthetic?: boolean } = {}) {
  ms.forEach((m, i) =>
    insertRound(target, {
      multiplierX100: m,
      source: SOURCE,
      sourceRoundId: `r-${start + i}`,
      observedAt: '2026-06-01T00:00:00.000Z',
      eventAt: at(start + i),
      importId: null,
      isSynthetic: extra.synthetic ?? false,
    }),
  );
}

function backtestRequest(risk: Record<string, unknown> = {}) {
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
      startingBankrollMinor: 50_000,
      insufficientBankrollPolicy: 'skip_leg',
      risk: {
        stopBelowBankrollMinor: null,
        stopAtOrAboveBankrollMinor: null,
        maxDrawdownBps: null,
        maxRounds: null,
        ...risk,
      },
    },
    dataset: { source: SOURCE },
  };
}

const json = (body: unknown, method = 'POST') => ({
  method,
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify(body),
});

async function createRun(body: unknown = backtestRequest(), base = server.baseUrl) {
  const res = await fetch(`${base}/api/simulations`, json(body));
  expect(res.status).toBe(201);
  return simulationRunDtoSchema.parse(await res.json());
}

const analyse = (runId: number, body: unknown, base = server.baseUrl) =>
  fetch(`${base}/api/simulations/${runId}/robustness`, json(body));

async function analyseOk(
  runId: number,
  windows = 3,
  base = server.baseUrl,
): Promise<RobustnessAnalysisDto> {
  const res = await analyse(runId, { windows }, base);
  expect(res.status, await res.clone().text()).toBe(201);
  return robustnessAnalysisDtoSchema.parse(await res.json());
}

const get = (path: string) => fetch(`${server.baseUrl}/api/simulations/${path}`);
const count = (table = 'simulation_robustness_analyses', target = db) =>
  (target.prepare(`SELECT COUNT(*) AS n FROM ${table}`).get() as { n: number }).n;
const snapshot = () => ({
  rounds: db.prepare('SELECT * FROM rounds ORDER BY id').all(),
  runs: db.prepare('SELECT * FROM simulation_runs ORDER BY id').all(),
  ledger: db.prepare('SELECT * FROM ledger_entries ORDER BY id').all(),
});

async function errorOf(res: Response) {
  return apiErrorSchema.parse(await res.json()).error;
}

describe('POST /api/simulations/:id/robustness', () => {
  it("replays the run's dataset in chronological blocks and stores the verified result", async () => {
    seedSeries(db, multipliers(100));
    seedSeries(db, [990, 990], 500, { synthetic: true }); // synthetic rounds are never used
    const run = await createRun();
    const before = snapshot();
    const analysis = await analyseOk(run.id, 3);

    expect(analysis).toMatchObject({
      simulationRunId: run.id,
      status: 'completed',
      algorithmVersion: ROBUSTNESS_ALGORITHM_VERSION,
      resultSchemaVersion: ROBUSTNESS_RESULT_SCHEMA_VERSION,
      windows: 3,
      sampleSize: 100,
      datasetSha256: run.datasetSha256,
    });
    // Exactly the shared engine's output over the run's eligible rounds.
    const rounds = loadReplayRounds(db, run.datasetRequest);
    expect(analysis.result).toEqual(
      runBlockRobustness(rounds, run.strategy, run.settings, { windows: 3 }),
    );
    // The full-sample replay is the run's own stored result.
    expect(analysis.result.full.summary).toEqual(run.summary);
    expect(analysis.result.blocks.map((b) => [b.startIndex, b.endIndex])).toEqual([
      [0, 34],
      [34, 67],
      [67, 100],
    ]);
    expect(analysis.result.blocks[1]).toMatchObject({
      firstRoundId: rounds[34]!.roundId,
      lastRoundId: rounds[66]!.roundId,
      firstEventAt: at(34),
      lastEventAt: at(66),
    });
    // Historical rounds, the run and its ledger are only read.
    expect(snapshot()).toEqual(before);
    expect(count()).toBe(1);
  });

  it('produces identical results for the same run and block count', async () => {
    seedSeries(db, multipliers(90));
    const run = await createRun();
    const a = await analyseOk(run.id, 3);
    const b = await analyseOk(run.id, 3);
    expect(b.id).not.toBe(a.id);
    expect(b.result).toEqual(a.result);
  });

  it('analyses an early-stopped run over its whole eligible dataset', async () => {
    seedSeries(db, [100, 100, 100, ...multipliers(87)]);
    const run = await createRun(backtestRequest({ stopBelowBankrollMinor: 49_500 }));
    expect(run.summary).toMatchObject({ stopReason: 'stop_below', roundsReplayed: 3 });
    const analysis = await analyseOk(run.id, 3);
    expect(analysis.sampleSize).toBe(90);
    expect(analysis.result.full.summary).toEqual(run.summary);
    // Blocks 1 and 2 start again from the configured bankroll and are not stopped by block 0.
    expect(analysis.result.blocks.map((b) => b.summary.startingBankrollMinor)).toEqual([
      50_000, 50_000, 50_000,
    ]);
  });

  it('validates the request strictly (400) and stores nothing', async () => {
    seedSeries(db, multipliers(90));
    const run = await createRun();
    for (const body of [
      {},
      { windows: 1 },
      { windows: 11 },
      { windows: 2.5 },
      { windows: '3' },
      { windows: 3, extra: true },
      { windows: 3, result: { blocks: [] } },
      [],
    ]) {
      const res = await analyse(run.id, body);
      expect(res.status, JSON.stringify(body)).toBe(400);
      expect((await errorOf(res)).code).toBe('validation_error');
    }
    expect(count()).toBe(0);
  });

  it('refuses failed runs (409) and unknown runs (404)', async () => {
    seedSeries(db, multipliers(90));
    db.exec(`CREATE TRIGGER fail_ledger BEFORE INSERT ON ledger_entries
             BEGIN SELECT RAISE(ABORT, 'injected'); END;`);
    expect((await fetch(`${server.baseUrl}/api/simulations`, json(backtestRequest()))).status).toBe(
      500,
    );
    db.exec('DROP TRIGGER fail_ledger');
    const failedId = (
      db.prepare("SELECT id FROM simulation_runs WHERE status = 'failed'").get() as { id: number }
    ).id;
    const res = await analyse(failedId, { windows: 2 });
    expect(res.status).toBe(409);
    expect((await errorOf(res)).code).toBe('run_not_analyzable');
    expect((await analyse(999, { windows: 2 })).status).toBe(404);
    expect((await analyse(0, { windows: 2 })).status).toBe(404);
    expect(count()).toBe(0);
  });

  it('refuses block counts the sample cannot support (422) before reading the dataset', async () => {
    seedSeries(db, multipliers(90));
    const run = await createRun();
    // Change the dataset: a check that read it would answer 409 dataset_changed instead.
    seedSeries(db, [250], 900);
    const res = await analyse(run.id, { windows: 4 });
    expect(res.status).toBe(422);
    expect(await errorOf(res)).toMatchObject({
      code: 'robustness_sample_too_small',
      details: { maxWindows: 3, sampleSize: 90 },
    });
    expect(count()).toBe(0);
  });

  it('refuses a sample too small for any blocks (422)', async () => {
    seedSeries(db, multipliers(59));
    const run = await createRun();
    const res = await analyse(run.id, { windows: 2 });
    expect(res.status).toBe(422);
    expect(await errorOf(res)).toMatchObject({
      code: 'robustness_sample_too_small',
      details: { maxWindows: 0, sampleSize: 59 },
    });
    const list = robustnessAnalysesListSchema.parse(
      await (await get(`${run.id}/robustness`)).json(),
    );
    expect(list).toMatchObject({ maxWindows: 0, sampleSize: 59, total: 0 });
  });

  it('refuses when the dataset changed since the run (409), storing nothing', async () => {
    seedSeries(db, multipliers(90));
    const run = await createRun();
    db.prepare('UPDATE rounds SET multiplier_x100 = 333 WHERE id = 40').run();
    const changedMultiplier = await analyse(run.id, { windows: 2 });
    expect(changedMultiplier.status).toBe(409);
    expect((await errorOf(changedMultiplier)).code).toBe('dataset_changed');
    db.prepare(`UPDATE rounds SET event_at = '2026-01-01T00:00:40.500Z' WHERE id = 40`).run();
    expect((await analyse(run.id, { windows: 2 })).status).toBe(409);
    expect(count()).toBe(0);
  });

  it('refuses a result whose source changed while it was being computed (409), storing nothing', async () => {
    seedSeries(db, multipliers(90));
    // The service is called directly so the data can change between computing and storing.
    const run = getRun(db, (await createRun()).id)!;
    const call = (afterCompute: () => void) =>
      runAndStoreRobustness(
        db,
        run,
        { windows: 3 },
        {
          now: () => new Date('2026-07-01T00:00:00.000Z'),
          maxRounds: 100_000,
          log: () => {},
          afterCompute,
        },
      );
    expect(() =>
      call(() => db.prepare('UPDATE rounds SET multiplier_x100 = 444 WHERE id = 10').run()),
    ).toThrow(expect.objectContaining({ status: 409, code: 'dataset_changed' }) as HttpError);
    expect(count()).toBe(0);
    // Restored data stores normally through the same path.
    db.prepare('UPDATE rounds SET multiplier_x100 = ? WHERE id = 10').run(multipliers(90)[9]);
    expect(call(() => {}).windows).toBe(3);
    expect(count()).toBe(1);
  });

  it('stores nothing when the write fails, with a generic 500 that leaks no internals', async () => {
    seedSeries(db, multipliers(90));
    const run = await createRun();
    db.exec(`CREATE TRIGGER fail_robustness BEFORE INSERT ON simulation_robustness_analyses
             BEGIN SELECT RAISE(ABORT, 'injected robustness failure'); END;`);
    const res = await analyse(run.id, { windows: 2 });
    expect(res.status).toBe(500);
    const body = apiErrorSchema.parse(await res.json());
    expect(body.error).toEqual({ code: 'robustness_failed', message: FAILED_ROBUSTNESS_MESSAGE });
    expect(JSON.stringify(body)).not.toMatch(/injected|SQLITE|simulation_robustness/);
    expect(logged).toHaveLength(1);
    expect(count()).toBe(0);
  });
});

describe('reading and deleting robustness analyses', () => {
  it('lists newest first with pagination, a block-count filter and the run limits', async () => {
    seedSeries(db, multipliers(120));
    const run = await createRun();
    const created = [];
    for (const windows of [2, 3, 3, 4]) created.push(await analyseOk(run.id, windows));

    const all = robustnessAnalysesListSchema.parse(
      await (await get(`${run.id}/robustness`)).json(),
    );
    expect(all).toMatchObject({ total: 4, limit: 20, offset: 0, maxWindows: 4, sampleSize: 120 });
    expect(all.items.map((a) => a.id)).toEqual(created.map((a) => a.id).reverse());

    const page = robustnessAnalysesListSchema.parse(
      await (await get(`${run.id}/robustness?limit=2&offset=1`)).json(),
    );
    expect(page.items.map((a) => a.id)).toEqual([created[2]!.id, created[1]!.id]);
    expect(page.total).toBe(4);

    const threes = robustnessAnalysesListSchema.parse(
      await (await get(`${run.id}/robustness?windows=3`)).json(),
    );
    expect(threes.total).toBe(2);
    expect(threes.items.every((a) => a.windows === 3)).toBe(true);

    for (const query of ['limit=0', 'limit=51', 'offset=-1', 'windows=1', 'windows=11', 'x=1']) {
      expect((await get(`${run.id}/robustness?${query}`)).status, query).toBe(400);
    }
  });

  it('returns one analysis, scoped to its run, identically on every read', async () => {
    seedSeries(db, multipliers(90));
    const run = await createRun();
    const other = await createRun();
    const analysis = await analyseOk(run.id, 2);
    const first = robustnessAnalysisDtoSchema.parse(
      await (await get(`${run.id}/robustness/${analysis.id}`)).json(),
    );
    const second = robustnessAnalysisDtoSchema.parse(
      await (await get(`${run.id}/robustness/${analysis.id}`)).json(),
    );
    expect(first).toEqual(analysis);
    expect(second).toEqual(first);
    for (const path of [
      `${other.id}/robustness/${analysis.id}`,
      `${run.id}/robustness/999`,
      `${run.id}/robustness/abc`,
      `${run.id}/robustness/01`,
      `999/robustness/${analysis.id}`,
    ]) {
      const res = await get(path);
      expect(res.status, path).toBe(404);
    }
  });

  it('deletes one analysis (204) without touching anything else; deleting the run cascades', async () => {
    seedSeries(db, multipliers(90));
    const run = await createRun();
    const keep = await analyseOk(run.id, 2);
    const remove = await analyseOk(run.id, 3);
    const before = snapshot();
    const del = (path: string) =>
      fetch(`${server.baseUrl}/api/simulations/${path}`, { method: 'DELETE' });
    expect((await del(`${run.id}/robustness/${remove.id}`)).status).toBe(204);
    expect((await get(`${run.id}/robustness/${remove.id}`)).status).toBe(404);
    expect((await del(`${run.id}/robustness/${remove.id}`)).status).toBe(404);
    expect((await get(`${run.id}/robustness/${keep.id}`)).status).toBe(200);
    expect(snapshot()).toEqual(before);
    db.prepare('DELETE FROM simulation_runs WHERE id = ?').run(run.id);
    expect(count()).toBe(0);
  });
});

describe('stored robustness analyses are verified on every read', () => {
  /** Inserts a copy of a valid row with selected columns or JSON replaced. */
  function insertVariant(
    analysis: RobustnessAnalysisDto,
    change: {
      result?: (r: RobustnessAnalysisDto['result']) => unknown;
      config?: (c: Record<string, unknown>) => unknown;
      resultSchemaVersion?: number;
      windows?: number;
      algorithmVersion?: string;
    },
  ): number {
    const row = db
      .prepare('SELECT * FROM simulation_robustness_analyses WHERE id = ?')
      .get(analysis.id) as Record<string, string | number>;
    const result = structuredClone(analysis.result);
    const config = JSON.parse(row.config_json as string) as Record<string, unknown>;
    return Number(
      db
        .prepare(
          `INSERT INTO simulation_robustness_analyses (simulation_run_id, status, method,
             algorithm_version, result_schema_version, windows, sample_size, dataset_sha256,
             config_json, result_json, created_at, completed_at)
           VALUES (?, 'completed', 'chronological_blocks', ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        )
        .run(
          row.simulation_run_id,
          change.algorithmVersion ?? row.algorithm_version,
          change.resultSchemaVersion ?? row.result_schema_version,
          change.windows ?? row.windows,
          row.sample_size,
          row.dataset_sha256,
          JSON.stringify(change.config ? change.config(config) : config),
          JSON.stringify(change.result ? change.result(result) : result),
          row.created_at,
          row.completed_at,
        ).lastInsertRowid,
    );
  }

  it('reports each kind of corruption as stored_data_invalid (500) without changing the row', async () => {
    seedSeries(db, multipliers(100)); // blocks of 34, 33, 33: room to shrink a block
    const run = await createRun();
    const good = await analyseOk(run.id, 3);
    const cases: [string, Parameters<typeof insertVariant>[1], RegExp][] = [
      ['unsupported result schema version', { resultSchemaVersion: 2 }, /result schema version 2/],
      [
        'unsupported algorithm version',
        {
          algorithmVersion: 'chronological-blocks/v0',
          result: (r) => ({ ...r, algorithmVersion: 'chronological-blocks/v0' }),
        },
        /unsupported algorithm version/,
      ],
      ['corrupted JSON', { result: () => ({ blocks: 'nope' }) }, /verification/],
      ['window count column mismatch', { windows: 2 }, /declares 3 windows; 2 were requested/],
      [
        'block count mismatch',
        { result: (r) => ({ ...r, blocks: r.blocks.slice(0, 2) }) },
        /2 blocks for 3 windows/,
      ],
      [
        'gap between blocks',
        {
          result: (r) => {
            r.blocks[1]!.startIndex += 1;
            r.blocks[1]!.roundCount -= 1;
            return r;
          },
        },
        /gap before block 1/,
      ],
      [
        'overlapping blocks',
        {
          result: (r) => {
            r.blocks[2]!.startIndex -= 1;
            r.blocks[2]!.roundCount += 1;
            return r;
          },
        },
        /block 2 overlaps/,
      ],
      [
        'wrong last index',
        {
          result: (r) => {
            r.blocks[2]!.endIndex -= 1;
            r.blocks[2]!.roundCount -= 1;
            return r;
          },
        },
        /not at the sample size 100/,
      ],
      [
        'invalid timestamp',
        {
          result: (r) => {
            r.blocks[1]!.firstEventAt = '2026-01-01T00:00:30+00:00';
            return r;
          },
        },
        /not canonical UTC/,
      ],
      [
        'altered full-sample result',
        {
          result: (r) => {
            r.full.summary.longestLosingStreak += 1;
            return r;
          },
        },
        /differs from the run's stored result/,
      ],
      [
        'configuration that differs from the run',
        {
          config: (c) => {
            const strategy = structuredClone(c.strategy) as { legs: { A: { stakeMinor: number } } };
            strategy.legs.A.stakeMinor = 101;
            return { ...c, strategy };
          },
        },
        /configuration differs/,
      ],
    ];
    for (const [name, change, cause] of cases) {
      const id = insertVariant(good, change);
      const stored = db
        .prepare('SELECT * FROM simulation_robustness_analyses WHERE id = ?')
        .get(id);
      logged.length = 0;
      const res = await get(`${run.id}/robustness/${id}`);
      expect(res.status, name).toBe(500);
      expect(await errorOf(res), name).toMatchObject({
        code: 'stored_data_invalid',
        details: { simulationRunId: run.id, robustnessAnalysisId: id },
      });
      const error = logged[0] as Error & { cause: Error };
      expect(error.cause.message, name).toMatch(cause);
      // The list refuses too, rather than silently skipping the row.
      expect((await get(`${run.id}/robustness`)).status, name).toBe(500);
      expect(
        db.prepare('SELECT * FROM simulation_robustness_analyses WHERE id = ?').get(id),
      ).toEqual(stored);
      db.prepare('DELETE FROM simulation_robustness_analyses WHERE id = ?').run(id);
    }
    expect((await get(`${run.id}/robustness/${good.id}`)).status).toBe(200);
  });

  it("refuses a stored analysis whose run's fingerprint no longer matches", async () => {
    seedSeries(db, multipliers(90));
    const run = await createRun();
    const analysis = await analyseOk(run.id, 2);
    db.prepare('UPDATE simulation_runs SET dataset_sha256 = ? WHERE id = ?').run(
      'c'.repeat(64),
      run.id,
    );
    const res = await get(`${run.id}/robustness/${analysis.id}`);
    expect(res.status).toBe(500);
    expect((logged[0] as Error & { cause: Error }).cause.message).toMatch(/fingerprint differs/);
  });
});

describe('simulation_robustness_analyses integrity', () => {
  it('enforces completed runs, matching fingerprints, valid sizes, no updates and cascade', async () => {
    seedSeries(db, multipliers(90));
    const run = await createRun();
    await analyseOk(run.id, 2);
    const insert = (
      runId: number,
      sha: string,
      windows = 2,
      sampleSize = 90,
      status = 'completed',
    ) =>
      db
        .prepare(
          `INSERT INTO simulation_robustness_analyses (simulation_run_id, status, method,
             algorithm_version, result_schema_version, windows, sample_size, dataset_sha256,
             config_json, result_json, created_at, completed_at)
           VALUES (?, ?, 'chronological_blocks', 'v1', 1, ?, ?, ?, '{}', '{}', 'x', 'x')`,
        )
        .run(runId, status, windows, sampleSize, sha);
    expect(() => insert(run.id, 'b'.repeat(64))).toThrow(/same dataset fingerprint/);
    expect(() => insert(999, run.datasetSha256!)).toThrow(/completed run/);
    expect(() => insert(run.id, run.datasetSha256!, 2, 90, 'running')).toThrow(/CHECK/);
    expect(() => insert(run.id, run.datasetSha256!, 11)).toThrow(/CHECK/);
    expect(() => insert(run.id, run.datasetSha256!, 4, 90)).toThrow(/CHECK/);
    expect(() => db.prepare('UPDATE simulation_robustness_analyses SET windows = 3').run()).toThrow(
      /cannot be updated/,
    );
    expect(count()).toBe(1);
    db.prepare('DELETE FROM simulation_runs WHERE id = ?').run(run.id);
    expect(count()).toBe(0);
  });

  it('migrates a database holding 001-004 data and analyses its existing runs', async () => {
    const legacy = openDatabase(':memory:');
    migrate(legacy, MIGRATIONS.slice(0, 4));
    seedSeries(legacy, multipliers(90));
    const runId = insertLegacyRun(legacy, backtestRequestSchema.parse(backtestRequest()));
    const before = {
      rounds: legacy.prepare('SELECT * FROM rounds ORDER BY id').all(),
      runs: legacy.prepare('SELECT * FROM simulation_runs ORDER BY id').all(),
    };
    expect(migrate(legacy)).toEqual({ applied: [5, 6, 7], currentVersion: 7 });
    expect(legacy.prepare('SELECT * FROM rounds ORDER BY id').all()).toEqual(before.rounds);
    expect(
      withoutColumns(
        legacy.prepare('SELECT * FROM simulation_runs ORDER BY id').all(),
        MIGRATION_006_RUN_COLUMNS,
      ),
    ).toEqual(before.runs);
    const legacyServer = await startTestServer(legacy);
    try {
      const run: SimulationRunDto = simulationRunDtoSchema.parse(
        await (await fetch(`${legacyServer.baseUrl}/api/simulations/${runId}`)).json(),
      );
      const analysis = await analyseOk(run.id, 3, legacyServer.baseUrl);
      expect(analysis.datasetSha256).toBe(run.datasetSha256);
    } finally {
      await legacyServer.close();
      legacy.close();
    }
  });
});
