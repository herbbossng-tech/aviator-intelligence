import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  apiErrorSchema,
  BOOTSTRAP_ALGORITHM_VERSION,
  backtestRequestSchema,
  blockAnalysesListSchema,
  blockAnalysisDtoSchema,
  blockBootstrapSummarySchema,
  MOVING_BLOCK_ALGORITHM_VERSION,
  runBlockBootstrap,
  runBootstrap,
  simulationAnalysisDtoSchema,
  simulationRunDtoSchema,
  type SimulationRunDto,
} from '@aviator/shared';
import { openDatabase, type Db } from '../src/db/connection.js';
import { migrate } from '../src/db/migrate.js';
import { MIGRATIONS } from '../src/db/migrations/index.js';
import { insertRound } from '../src/db/repositories/rounds.js';
import { getRun, loadReplayRounds } from '../src/db/repositories/simulations.js';
import { runAndStoreBlockAnalysis } from '../src/simulations/blockAnalysis.js';
import { createTestDb, insertLegacyRun, startTestServer } from './helpers.js';

// SYNTHETIC TEST FIXTURES: invented rounds in temporary in-memory databases only; the real
// data/aviator.sqlite is never opened. Virtual money only; analyses predict nothing.

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

const SOURCE = 'synthetic-block-analyses';
const at = (second: number) => new Date(Date.UTC(2026, 0, 1) + second * 1000).toISOString();
const BASE = [150, 150, 150, 250, 600, 150, 120, 990, 150, 150, 300, 101];
const MULTIPLIERS = Array.from({ length: 6 }, () => BASE).flat(); // 72 rounds: max b = 7

function seedSeries(target: Db, ms: number[], start = 0) {
  ms.forEach((m, i) =>
    insertRound(target, {
      multiplierX100: m,
      source: SOURCE,
      sourceRoundId: `ba-${start + i}`,
      observedAt: '2026-06-01T00:00:00.000Z',
      eventAt: at(start + i),
      importId: null,
      isSynthetic: false,
    }),
  );
}

const martingale = () => ({
  schemaVersion: 1,
  currency: 'NGN',
  winResetPolicy: 'reset_to_base',
  mode: 'martingale',
  baseStakeMinor: 50_000,
  multiplierX100: 200,
  limits: { maxSteps: 3, maxStakeMinor: null, maxCycleExposureMinor: 400_000 },
});
const custom = () => ({
  schemaVersion: 1,
  currency: 'NGN',
  winResetPolicy: 'reset_to_base',
  mode: 'custom',
  stakesMinor: [50_000, 120_000],
  afterFinalStep: 'stop',
  limits: { maxStakeMinor: null, maxCycleExposureMinor: null },
});
const plan = () => ({ schemaVersion: 1, legs: { A: martingale(), B: custom() } });

function request(staking: unknown = undefined) {
  return {
    strategy: {
      schemaVersion: 1,
      currency: 'NGN',
      legs: {
        A: { label: 'Leg A', enabled: true, stakeMinor: 50_000, cashoutTargetX100: 200 },
        B: { label: 'Leg B', enabled: true, stakeMinor: 50_000, cashoutTargetX100: 500 },
      },
    },
    settings: {
      schemaVersion: 1,
      currency: 'NGN',
      startingBankrollMinor: 600_000,
      insufficientBankrollPolicy: 'skip_leg',
      risk: {
        stopBelowBankrollMinor: null,
        stopAtOrAboveBankrollMinor: null,
        maxDrawdownBps: null,
        maxRounds: null,
      },
    },
    dataset: { source: SOURCE },
    ...(staking === undefined ? {} : { staking }),
  };
}

const postJson = (path: string, body: unknown, base = server.baseUrl) =>
  fetch(`${base}${path}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });

async function createRun(body: unknown, base = server.baseUrl): Promise<SimulationRunDto> {
  const res = await postJson('/api/simulations', body, base);
  expect(res.status, await res.clone().text()).toBe(201);
  return simulationRunDtoSchema.parse(await res.json());
}

async function blockAnalyse(runId: number, body: unknown, base = server.baseUrl) {
  const res = await postJson(`/api/simulations/${runId}/block-analyses`, body, base);
  expect(res.status, await res.clone().text()).toBe(201);
  return blockAnalysisDtoSchema.parse(await res.json());
}

async function expectError(res: Response, status: number, code: string) {
  expect(res.status).toBe(status);
  const body = apiErrorSchema.parse(await res.json());
  expect(body.error.code).toBe(code);
  return body;
}

const count = (table: string, target = db) =>
  (target.prepare(`SELECT COUNT(*) AS n FROM ${table}`).get() as { n: number }).n;
const rowOf = (id: number) =>
  db.prepare('SELECT * FROM simulation_block_bootstrap_analyses WHERE id = ?').get(id) as Record<
    string,
    unknown
  >;

describe('migration 007', () => {
  it('adds the block table on a fresh database and is idempotent', () => {
    expect(MIGRATIONS.map((m) => [m.version, m.name])).toEqual([
      [1, 'initial_schema'],
      [2, 'round_imports'],
      [3, 'simulation_backtests'],
      [4, 'simulation_analyses'],
      [5, 'robustness_analyses'],
      [6, 'backtest_progressions'],
      [7, 'block_bootstrap_analyses'],
    ]);
    const columns = (
      db.prepare('PRAGMA table_info(simulation_block_bootstrap_analyses)').all() as {
        name: string;
      }[]
    ).map((c) => c.name);
    expect(columns).toEqual([
      'id',
      'simulation_run_id',
      'status',
      'method',
      'algorithm_version',
      'seed',
      'paths',
      'sample_size',
      'block_length',
      'dataset_sha256',
      'config_json',
      'summary_json',
      'created_at',
      'completed_at',
    ]);
    expect(migrate(db)).toEqual({ applied: [], currentVersion: 7 });
  });

  it('migrates a schema-6 database without changing its runs, ledgers or IID analyses', async () => {
    const legacy = openDatabase(':memory:');
    migrate(legacy, MIGRATIONS.slice(0, 6));
    seedSeries(legacy, MULTIPLIERS);
    const parsed = backtestRequestSchema.parse(request());
    const runId = insertLegacyRun(legacy, parsed);
    const runRow = legacy
      .prepare('SELECT summary_json, dataset_sha256 FROM simulation_runs WHERE id = ?')
      .get(runId) as { summary_json: string; dataset_sha256: string };
    const sample = loadReplayRounds(legacy, parsed.dataset).map((r) => r.multiplierX100);
    const iid = runBootstrap(
      sample,
      parsed.strategy,
      parsed.settings,
      { paths: 10, seed: 4 },
      JSON.parse(runRow.summary_json),
    );
    legacy
      .prepare(
        `INSERT INTO simulation_analyses (simulation_run_id, status, method, algorithm_version,
           seed, paths, sample_size, dataset_sha256, config_json, summary_json, created_at,
           completed_at)
         VALUES (?, 'completed', 'iid_bootstrap', ?, 4, 10, ?, ?, ?, ?, 'x', 'x')`,
      )
      .run(
        runId,
        iid.algorithmVersion,
        sample.length,
        runRow.dataset_sha256,
        JSON.stringify({
          strategy: parsed.strategy,
          settings: parsed.settings,
          datasetRequest: parsed.dataset,
        }),
        JSON.stringify(iid),
      );
    const snapshot = (table: string) => legacy.prepare(`SELECT * FROM ${table}`).all();
    const before = ['simulation_runs', 'ledger_entries', 'simulation_analyses', 'rounds'].map(
      snapshot,
    );
    expect(migrate(legacy)).toEqual({ applied: [7], currentVersion: 7 });
    expect(
      ['simulation_runs', 'ledger_entries', 'simulation_analyses', 'rounds'].map(snapshot),
    ).toEqual(before);
    expect(migrate(legacy).applied).toEqual([]);
    const legacyServer = await startTestServer(legacy, () => {});
    try {
      // The old IID analysis still reads back, and the old run can be block-analysed.
      const iidRes = await fetch(`${legacyServer.baseUrl}/api/simulations/${runId}/analyses`);
      expect(iidRes.status).toBe(200);
      const block = await blockAnalyse(
        runId,
        { paths: 8, seed: 1, blockLength: 3 },
        legacyServer.baseUrl,
      );
      expect(block.method).toBe('moving_block_bootstrap');
      expect(count('simulation_analyses', legacy)).toBe(1);
    } finally {
      await legacyServer.close();
      legacy.close();
    }
  });

  it('enforces completed runs, matching fingerprints, constraints, immutability and cascade', async () => {
    seedSeries(db, MULTIPLIERS);
    const run = await createRun(request());
    const a = await blockAnalyse(run.id, { paths: 5, seed: 1, blockLength: 3 });
    const row = rowOf(a.id);
    const insert = (replace: Record<string, unknown>) =>
      db
        .prepare(
          `INSERT INTO simulation_block_bootstrap_analyses (simulation_run_id, status, method,
             algorithm_version, seed, paths, sample_size, block_length, dataset_sha256,
             config_json, summary_json, created_at, completed_at)
           VALUES (@simulation_run_id, @status, @method, @algorithm_version, @seed, @paths,
             @sample_size, @block_length, @dataset_sha256, @config_json, @summary_json,
             @created_at, @completed_at)`,
        )
        .run({ ...row, ...replace });
    expect(() => insert({ dataset_sha256: 'b'.repeat(64) })).toThrow(/same dataset fingerprint/);
    expect(() => insert({ simulation_run_id: 999 })).toThrow(/completed run/);
    expect(() => insert({ method: 'iid_bootstrap' })).toThrow(/CHECK/);
    expect(() => insert({ status: 'running' })).toThrow(/CHECK/);
    expect(() => insert({ block_length: 1 })).toThrow(/CHECK/);
    expect(() => insert({ block_length: 8 })).toThrow(/CHECK/); // 8 · 10 > 72
    expect(() => insert({ config_json: '{' })).toThrow(/CHECK/);
    expect(() =>
      db.prepare('UPDATE simulation_block_bootstrap_analyses SET seed = 2').run(),
    ).toThrow(/immutable/);
    expect(count('simulation_block_bootstrap_analyses')).toBe(1);
    db.prepare('DELETE FROM simulation_runs WHERE id = ?').run(run.id);
    expect(count('simulation_block_bootstrap_analyses')).toBe(0);
  });
});

describe('creating and reading block analyses', () => {
  it('computes with the shared engine and the run’s own plan, stores and returns it', async () => {
    seedSeries(db, MULTIPLIERS);
    const run = await createRun(request(plan()));
    const created = await blockAnalyse(run.id, { paths: 30, seed: 2024, blockLength: 5 });

    const parsed = backtestRequestSchema.parse(request(plan()));
    const sample = loadReplayRounds(db, parsed.dataset).map((r) => r.multiplierX100);
    expect(created.summary).toEqual(
      runBlockBootstrap(
        sample,
        parsed.strategy,
        parsed.settings,
        { paths: 30, seed: 2024, blockLength: 5 },
        run.summary!,
        parsed.staking,
      ),
    );
    expect(created).toMatchObject({
      simulationRunId: run.id,
      status: 'completed',
      method: 'moving_block_bootstrap',
      algorithmVersion: MOVING_BLOCK_ALGORITHM_VERSION,
      seed: 2024,
      paths: 30,
      blockLength: 5,
      sampleSize: 72,
      datasetSha256: run.datasetSha256,
    });
    expect(created.summary.staking?.statePolicy).toBe('reset_each_path');
    expect(blockBootstrapSummarySchema.parse(created.summary)).toEqual(created.summary);
    const row = rowOf(created.id);
    expect(row).toMatchObject({
      method: 'moving_block_bootstrap',
      seed: 2024,
      paths: 30,
      sample_size: 72,
      block_length: 5,
    });
    expect(JSON.parse(String(row.config_json)).staking).toEqual(run.staking);
  });

  it('reads back exactly what was stored, without recomputing, and lists it', async () => {
    seedSeries(db, MULTIPLIERS);
    const run = await createRun(request());
    const created = await blockAnalyse(run.id, { paths: 12, seed: 7, blockLength: 4 });
    const rowBefore = rowOf(created.id);
    // Change the run's dataset afterwards: a recomputation would fail or differ; a read of
    // the stored row does neither.
    seedSeries(db, [500], 1_000);
    for (let i = 0; i < 2; i++) {
      const res = await fetch(
        `${server.baseUrl}/api/simulations/${run.id}/block-analyses/${created.id}`,
      );
      expect(res.status).toBe(200);
      expect(blockAnalysisDtoSchema.parse(await res.json())).toEqual(created);
    }
    expect(rowOf(created.id)).toEqual(rowBefore);
    const list = blockAnalysesListSchema.parse(
      await (await fetch(`${server.baseUrl}/api/simulations/${run.id}/block-analyses`)).json(),
    );
    expect(list).toEqual({
      items: [created],
      total: 1,
      maxPaths: 2_000,
      maxBlockLength: 7,
      defaultBlockLength: 4, // ∛72 ≈ 4.16
      sampleSize: 72,
    });
  });

  it('is deterministic for the same request, and never mixes with IID analyses', async () => {
    seedSeries(db, MULTIPLIERS);
    const run = await createRun(request(plan()));
    const a = await blockAnalyse(run.id, { paths: 10, seed: 3, blockLength: 4 });
    const b = await blockAnalyse(run.id, { paths: 10, seed: 3, blockLength: 4 });
    expect(b.id).not.toBe(a.id);
    expect(b.summary).toEqual(a.summary);

    const iidRes = await postJson(`/api/simulations/${run.id}/analyses`, { paths: 10, seed: 3 });
    expect(iidRes.status).toBe(201);
    const iid = simulationAnalysisDtoSchema.parse(await iidRes.json());
    expect(iid.algorithmVersion).toBe(BOOTSTRAP_ALGORITHM_VERSION);
    expect(Object.keys(iid).sort()).toEqual(
      [
        'algorithmVersion',
        'completedAt',
        'createdAt',
        'datasetSha256',
        'id',
        'paths',
        'seed',
        'simulationRunId',
        'status',
        'summary',
      ].sort(),
    );
    expect('resampling' in iid.summary || 'longestLosingStreak' in iid.summary).toBe(false);
    expect(count('simulation_analyses')).toBe(1);
    expect(count('simulation_block_bootstrap_analyses')).toBe(2);
    const iidList = await (
      await fetch(`${server.baseUrl}/api/simulations/${run.id}/analyses`)
    ).json();
    expect((iidList as { items: unknown[] }).items).toHaveLength(1);
    // An IID id is not a block analysis of this run, and vice versa (separate tables).
    await expectError(
      await fetch(`${server.baseUrl}/api/simulations/${run.id}/block-analyses/${iid.id + 100}`),
      404,
      'block_analysis_not_found',
    );
    expect(a.summary.algorithmVersion).not.toBe(iid.summary.algorithmVersion);
  });
});

describe('request validation', () => {
  it('rejects invalid bodies with 400 before any work', async () => {
    seedSeries(db, MULTIPLIERS);
    const run = await createRun(request());
    for (const body of [
      { paths: 10, seed: 1 }, // no block length
      { paths: 10, seed: 1, blockLength: 1 },
      { paths: 10, seed: 1, blockLength: 501 },
      { paths: 10, seed: 1, blockLength: 2.5 },
      { paths: 10, seed: 1, blockLength: '4' },
      { paths: 0, seed: 1, blockLength: 4 },
      { paths: 2_001, seed: 1, blockLength: 4 },
      { paths: 10, seed: -1, blockLength: 4 },
      { paths: 10, seed: 1, blockLength: 4, method: 'iid' },
      { paths: 10, seed: 1, blockLength: 4, staking: null },
    ]) {
      await expectError(
        await postJson(`/api/simulations/${run.id}/block-analyses`, body),
        400,
        'validation_error',
      );
    }
    expect(count('simulation_block_bootstrap_analyses')).toBe(0);
  });

  it('checks the sample-dependent limits from the run before reading the dataset (422)', async () => {
    seedSeries(db, MULTIPLIERS);
    const run = await createRun(request());
    // Change the dataset so that reading it would give 409: the 422s below prove the limits
    // are checked first, from the run's recorded sample size.
    seedSeries(db, [500], 1_000);
    const tooLong = await expectError(
      await postJson(`/api/simulations/${run.id}/block-analyses`, {
        paths: 10,
        seed: 1,
        blockLength: 8,
      }),
      422,
      'block_length_too_large',
    );
    expect(tooLong.error.details).toEqual({ maxBlockLength: 7, sampleSize: 72 });
    await expectError(
      await postJson(`/api/simulations/${run.id}/block-analyses`, {
        paths: 10,
        seed: 1,
        blockLength: 4,
      }),
      409,
      'dataset_changed',
    );
    expect(count('simulation_block_bootstrap_analyses')).toBe(0);
  });

  it('refuses samples below 20 rounds and paths over the work limit (422)', async () => {
    seedSeries(db, MULTIPLIERS.slice(0, 19));
    const small = await createRun(request());
    const res = await expectError(
      await postJson(`/api/simulations/${small.id}/block-analyses`, {
        paths: 10,
        seed: 1,
        blockLength: 2,
      }),
      422,
      'analysis_sample_too_small',
    );
    expect(res.error.details).toEqual({ sampleSize: 19, minSampleSize: 20 });
    const list = blockAnalysesListSchema.parse(
      await (await fetch(`${server.baseUrl}/api/simulations/${small.id}/block-analyses`)).json(),
    );
    expect(list).toMatchObject({ maxPaths: 0, maxBlockLength: 0, defaultBlockLength: null });

    const large = createTestDb();
    try {
      seedSeries(
        large,
        Array.from({ length: 600 }, (_, i) => BASE[i % BASE.length]!),
      );
      const largeServer = await startTestServer(large, () => {});
      try {
        const bigRun = await createRun(request(), largeServer.baseUrl);
        const over = await expectError(
          await postJson(
            `/api/simulations/${bigRun.id}/block-analyses`,
            { paths: 1_700, seed: 1, blockLength: 8 },
            largeServer.baseUrl,
          ),
          422,
          'analysis_too_large',
        );
        expect(over.error.details).toEqual({ maxPaths: 1_666, sampleSize: 600 });
        expect(count('simulation_block_bootstrap_analyses', large)).toBe(0);
      } finally {
        await largeServer.close();
      }
    } finally {
      large.close();
    }
  });

  it('uses the established errors for unknown runs, ids and failed runs', async () => {
    seedSeries(db, MULTIPLIERS);
    const run = await createRun(request());
    await expectError(
      await postJson('/api/simulations/999/block-analyses', { paths: 5, seed: 1, blockLength: 3 }),
      404,
      'simulation_not_found',
    );
    for (const id of ['999', '1e0', '-1', 'abc', '01']) {
      await expectError(
        await fetch(`${server.baseUrl}/api/simulations/${run.id}/block-analyses/${id}`),
        404,
        'block_analysis_not_found',
      );
    }
    // An analysis of another run is not found under this run.
    const other = await createRun(request());
    const a = await blockAnalyse(other.id, { paths: 5, seed: 1, blockLength: 3 });
    await expectError(
      await fetch(`${server.baseUrl}/api/simulations/${run.id}/block-analyses/${a.id}`),
      404,
      'block_analysis_not_found',
    );
    // A failed run cannot be analysed.
    db.exec(`CREATE TRIGGER fail_ledger BEFORE INSERT ON ledger_entries
             BEGIN SELECT RAISE(ABORT, 'injected'); END;`);
    expect((await postJson('/api/simulations', request())).status).toBe(500);
    db.exec('DROP TRIGGER fail_ledger');
    const failed = (
      db.prepare("SELECT id FROM simulation_runs WHERE status = 'failed'").get() as { id: number }
    ).id;
    await expectError(
      await postJson(`/api/simulations/${failed}/block-analyses`, {
        paths: 5,
        seed: 1,
        blockLength: 3,
      }),
      409,
      'run_not_analyzable',
    );
  });
});

describe('stored-data integrity', () => {
  async function setup() {
    seedSeries(db, MULTIPLIERS);
    const flat = await createRun(request());
    const prog = await createRun(request(plan()));
    const a = await blockAnalyse(prog.id, { paths: 10, seed: 5, blockLength: 4 });
    const copy = (replace: Record<string, unknown>) =>
      Number(
        db
          .prepare(
            `INSERT INTO simulation_block_bootstrap_analyses (simulation_run_id, status, method,
               algorithm_version, seed, paths, sample_size, block_length, dataset_sha256,
               config_json, summary_json, created_at, completed_at)
             VALUES (@simulation_run_id, @status, @method, @algorithm_version, @seed, @paths,
               @sample_size, @block_length, @dataset_sha256, @config_json, @summary_json,
               @created_at, @completed_at)`,
          )
          .run({ ...rowOf(a.id), ...replace }).lastInsertRowid,
      );
    return { flat, prog, a, copy };
  }
  const summaryWith = (id: number, change: (s: Record<string, unknown>) => void) => {
    const s = JSON.parse(String(rowOf(id).summary_json)) as Record<string, unknown>;
    change(s);
    return JSON.stringify(s);
  };
  async function expectInvalid(runId: number, id: number) {
    const res = await fetch(`${server.baseUrl}/api/simulations/${runId}/block-analyses/${id}`);
    const body = await expectError(res, 500, 'stored_data_invalid');
    expect(body.error.details).toEqual({ simulationRunId: runId, blockAnalysisId: id });
    // No internal detail (SQL, stack, path, cause) is sent to the client.
    expect(JSON.stringify(body)).not.toMatch(/SELECT|INSERT|at \/|\.ts|sqlite|ZodError/i);
  }

  it('reports corrupt, incompatible or contradictory rows as stored_data_invalid', async () => {
    const { flat, prog, a, copy } = await setup();
    const cases: [string, number, number][] = [
      ['summary not an object', prog.id, copy({ summary_json: '{}' })],
      [
        'summary JSON parses but misses a field',
        prog.id,
        copy({
          summary_json: summaryWith(a.id, (s) => delete s.longestLosingStreak),
        }),
      ],
      [
        'unsupported algorithm version',
        prog.id,
        copy({
          algorithm_version: 'moving-block-bootstrap/xoshiro128ss-fmix32/v2',
          summary_json: summaryWith(a.id, (s) => {
            s.algorithmVersion = 'moving-block-bootstrap/xoshiro128ss-fmix32/v2';
          }),
        }),
      ],
      ['seed column differs from the summary', prog.id, copy({ seed: 6 })],
      ['block length column differs from the summary', prog.id, copy({ block_length: 5 })],
      [
        'layout does not follow from b',
        prog.id,
        copy({
          summary_json: summaryWith(a.id, (s) => {
            (s.resampling as { candidateStarts: number }).candidateStarts += 1;
          }),
        }),
      ],
      [
        'counts do not add up to the paths',
        prog.id,
        copy({
          summary_json: summaryWith(a.id, (s) => {
            (s.netOutcome as { positive: number }).positive += 1;
          }),
        }),
      ],
      [
        'unordered distribution',
        prog.id,
        copy({
          summary_json: summaryWith(a.id, (s) => {
            const d = s.endingBankrollMinor as { min: number; max: number };
            d.min = d.max + 1;
          }),
        }),
      ],
      [
        'staking metadata removed',
        prog.id,
        copy({
          summary_json: summaryWith(a.id, (s) => delete s.staking),
        }),
      ],
      [
        'snapshot without the plan',
        prog.id,
        copy({
          config_json: (() => {
            const c = JSON.parse(String(rowOf(a.id).config_json)) as Record<string, unknown>;
            delete c.staking;
            return JSON.stringify(c);
          })(),
        }),
      ],
      [
        "sample size differs from the run's sample (internally consistent)",
        prog.id,
        copy({
          sample_size: 70,
          summary_json: summaryWith(a.id, (s) => {
            (s.sample as { size: number }).size = 70;
            s.pathLength = 70;
            // 70 rounds with b = 4: K = 18, L = 2, S = 67.
            s.resampling = {
              ...(s.resampling as object),
              blocksPerPath: 18,
              lastBlockLength: 2,
              candidateStarts: 67,
            };
          }),
        }),
      ],
      [
        "observed snapshot differs from the run's summary",
        prog.id,
        copy({
          summary_json: summaryWith(a.id, (s) => {
            (s.observed as { endingBankrollMinor: number }).endingBankrollMinor += 1;
          }),
        }),
      ],
      [
        'boundary reported for a stop the run did not configure',
        prog.id,
        copy({
          summary_json: summaryWith(a.id, (s) => {
            (s.configuredBoundaries as Record<string, unknown>).lowerBankrollStop = {
              thresholdMinor: 1,
              count: 999,
              denominator: 10,
            };
          }),
        }),
      ],
      [
        'quantile levels missing',
        prog.id,
        copy({
          summary_json: summaryWith(a.id, (s) => {
            (s.endingBankrollMinor as { quantiles: unknown[] }).quantiles = [];
          }),
        }),
      ],
      // The fingerprint trigger cannot tell runs on the same data apart; the read check does.
      [
        'progression analysis attached to a flat run',
        flat.id,
        copy({ simulation_run_id: flat.id }),
      ],
    ];
    for (const [label, runId, id] of cases) {
      await expectInvalid(runId, id).catch((error: unknown) => {
        throw new Error(`${label}: ${String(error)}`);
      });
    }
    expect(logged.length).toBeGreaterThanOrEqual(cases.length);
    // The genuine row still reads back, and the list reports the first bad row.
    expect(
      (await fetch(`${server.baseUrl}/api/simulations/${prog.id}/block-analyses/${a.id}`)).status,
    ).toBe(200);
    expect(
      (await fetch(`${server.baseUrl}/api/simulations/${prog.id}/block-analyses`)).status,
    ).toBe(500);
  });

  it('reads back a genuine analysis of a run with both stops configured', async () => {
    seedSeries(db, MULTIPLIERS);
    const base = request();
    const body = {
      ...base,
      settings: {
        ...base.settings,
        risk: { ...base.settings.risk, stopBelowBankrollMinor: 400_000, maxDrawdownBps: 2_000 },
      },
    };
    const run = await createRun(body);
    const a = await blockAnalyse(run.id, { paths: 40, seed: 3, blockLength: 4 });
    const b = a.summary.configuredBoundaries;
    expect(b.lowerBankrollStop).toEqual({
      thresholdMinor: 400_000,
      count: a.summary.stopReasons.stop_below,
      denominator: 40,
    });
    expect(b.maxDrawdownStop?.thresholdBps).toBe(2_000);
    expect(b.lowerBankrollStop!.count + b.maxDrawdownStop!.count).toBeGreaterThan(0);
    const res = await fetch(`${server.baseUrl}/api/simulations/${run.id}/block-analyses/${a.id}`);
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual(a);
  });

  it('stores nothing when storing fails, without leaking internals', async () => {
    seedSeries(db, MULTIPLIERS);
    const run = await createRun(request());
    db.exec(`CREATE TRIGGER fail_block BEFORE INSERT ON simulation_block_bootstrap_analyses
             BEGIN SELECT RAISE(ABORT, 'injected storage failure'); END;`);
    const body = await expectError(
      await postJson(`/api/simulations/${run.id}/block-analyses`, {
        paths: 5,
        seed: 1,
        blockLength: 3,
      }),
      500,
      'block_analysis_failed',
    );
    expect(JSON.stringify(body)).not.toMatch(/injected|trigger|sqlite/i);
    expect(count('simulation_block_bootstrap_analyses')).toBe(0);
    expect(logged.some((e) => String(e).includes('injected storage failure'))).toBe(true);
  });

  it('refuses to store a result if the rounds change while it is computed', () => {
    seedSeries(db, MULTIPLIERS);
    const parsed = backtestRequestSchema.parse(request());
    const runId = insertLegacyRun(db, parsed);
    const run = getRun(db, runId)!;
    expect(() =>
      runAndStoreBlockAnalysis(
        db,
        run,
        { paths: 5, seed: 1, blockLength: 3 },
        {
          now: () => new Date('2026-02-01T00:00:00.000Z'),
          maxRounds: 100_000,
          log: () => {},
          afterCompute: () => seedSeries(db, [500], 2_000),
        },
      ),
    ).toThrow(/changed since it ran/);
    expect(count('simulation_block_bootstrap_analyses')).toBe(0);
  });
});
