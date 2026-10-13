import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  apiErrorSchema,
  backtestRequestSchema,
  progressionConfigKey,
  robustnessAnalysesListSchema,
  robustnessAnalysisDtoSchema,
  runBlockRobustness,
  runBootstrap,
  simulationAnalysesListSchema,
  simulationAnalysisDtoSchema,
  simulationRunDtoSchema,
  type SimulationRunDto,
  type StakingPlan,
} from '@aviator/shared';
import { openDatabase, type Db } from '../src/db/connection.js';
import { migrate } from '../src/db/migrate.js';
import { MIGRATIONS } from '../src/db/migrations/index.js';
import { insertRound } from '../src/db/repositories/rounds.js';
import { loadReplayRounds } from '../src/db/repositories/simulations.js';
import { createTestDb, insertLegacyRun, startTestServer } from './helpers.js';

// SYNTHETIC TEST FIXTURES: invented rounds in temporary in-memory databases only.
// Arithmetic examples, not recommendations; virtual money only. Analyses describe these
// invented rounds under stated assumptions and predict nothing.

let db: Db;
let server: Awaited<ReturnType<typeof startTestServer>>;

beforeEach(async () => {
  db = createTestDb();
  server = await startTestServer(db, () => {});
});
afterEach(async () => {
  await server.close();
  if (db.open) db.close();
});

const SOURCE = 'synthetic-progression-analyses';
const at = (second: number) => new Date(Date.UTC(2026, 0, 1) + second * 1000).toISOString();
const BASE = [150, 150, 150, 250, 600, 150, 120, 990, 150, 150, 300, 101];
const MULTIPLIERS = Array.from({ length: 6 }, () => BASE).flat(); // 72 rounds

function seedSeries(target: Db, ms: number[]) {
  ms.forEach((m, i) =>
    insertRound(target, {
      multiplierX100: m,
      source: SOURCE,
      sourceRoundId: `pa-${i}`,
      observedAt: '2026-06-01T00:00:00.000Z',
      eventAt: at(i),
      importId: null,
      isSynthetic: false,
    }),
  );
}

const martingale = (multiplierX100 = 200) => ({
  schemaVersion: 1,
  currency: 'NGN',
  winResetPolicy: 'reset_to_base',
  mode: 'martingale',
  baseStakeMinor: 50_000,
  multiplierX100,
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
const plan = (A: unknown = martingale(), B: unknown = custom()) => ({
  schemaVersion: 1,
  legs: { A, B },
});

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

async function createRun(body: unknown): Promise<SimulationRunDto> {
  const res = await postJson('/api/simulations', body);
  expect(res.status, await res.clone().text()).toBe(201);
  return simulationRunDtoSchema.parse(await res.json());
}

async function analyse(runId: number, body: unknown) {
  const res = await postJson(`/api/simulations/${runId}/analyses`, body);
  expect(res.status, await res.clone().text()).toBe(201);
  return simulationAnalysisDtoSchema.parse(await res.json());
}

async function robustness(runId: number, windows: number) {
  const res = await postJson(`/api/simulations/${runId}/robustness`, { windows });
  expect(res.status, await res.clone().text()).toBe(201);
  return robustnessAnalysisDtoSchema.parse(await res.json());
}

const configOf = (table: string, id: number) =>
  JSON.parse(
    (db.prepare(`SELECT config_json FROM ${table} WHERE id = ?`).get(id) as { config_json: string })
      .config_json,
  ) as Record<string, unknown>;

async function expectStoredDataInvalid(path: string) {
  const res = await fetch(`${server.baseUrl}${path}`);
  expect(res.status, path).toBe(500);
  expect(apiErrorSchema.parse(await res.json()).error.code).toBe('stored_data_invalid');
}

describe('uncertainty analysis of progression runs', () => {
  it("replays the run's own plan on every path, exactly as the shared engine does", async () => {
    seedSeries(db, MULTIPLIERS);
    const run = await createRun(request(plan()));
    const list = simulationAnalysesListSchema.parse(
      await (await fetch(`${server.baseUrl}/api/simulations/${run.id}/analyses`)).json(),
    );
    expect(list.maxPaths).toBeGreaterThan(0);

    const analysis = await analyse(run.id, { paths: 40, seed: 2024 });
    const parsed = backtestRequestSchema.parse(request(plan()));
    const sample = loadReplayRounds(db, parsed.dataset).map((r) => r.multiplierX100);
    expect(analysis.summary).toEqual(
      runBootstrap(
        sample,
        parsed.strategy,
        parsed.settings,
        { paths: 40, seed: 2024 },
        run.summary!,
        parsed.staking,
      ),
    );
    expect(analysis.summary.staking).toMatchObject({
      statePolicy: 'reset_each_path',
      legs: {
        A: { mode: 'martingale', configKey: progressionConfigKey(martingale()), denominator: 40 },
        B: { mode: 'custom', configKey: progressionConfigKey(custom()), denominator: 40 },
      },
    });
    // The stored configuration snapshot records the plan that was replayed.
    expect(configOf('simulation_analyses', analysis.id).staking).toEqual(run.staking);
    // Reproducible: the same seed gives the same result.
    expect((await analyse(run.id, { paths: 40, seed: 2024 })).summary).toEqual(analysis.summary);
  });

  it('leaves flat-stake analyses and their stored snapshot format unchanged', async () => {
    seedSeries(db, MULTIPLIERS);
    const run = await createRun(request());
    const analysis = await analyse(run.id, { paths: 20, seed: 7 });
    expect('staking' in analysis.summary).toBe(false);
    expect(Object.keys(configOf('simulation_analyses', analysis.id)).sort()).toEqual([
      'datasetRequest',
      'settings',
      'strategy',
    ]);
  });

  it('keeps analyses of different plans on the same data distinct', async () => {
    seedSeries(db, MULTIPLIERS);
    const r1 = await createRun(request(plan(martingale(200), null)));
    const r2 = await createRun(request(plan(martingale(300), null)));
    expect(r1.datasetSha256).toBe(r2.datasetSha256);
    const a1 = await analyse(r1.id, { paths: 20, seed: 1 });
    const a2 = await analyse(r2.id, { paths: 20, seed: 1 });
    expect(a1.summary.staking!.legs.A!.configKey).not.toBe(a2.summary.staking!.legs.A!.configKey);
    expect(a1.summary.endingBankrollMinor).not.toEqual(a2.summary.endingBankrollMinor);
  });

  it('validates requests for progression runs like any other (400, not 500)', async () => {
    seedSeries(db, MULTIPLIERS);
    const run = await createRun(request(plan()));
    for (const [body, status, code] of [
      [{ paths: 0, seed: 1 }, 400, 'validation_error'],
      [{ paths: 10 }, 400, 'validation_error'],
      [{ paths: 10, seed: 1, staking: null }, 400, 'validation_error'],
      [{ paths: 2_001, seed: 1 }, 400, 'validation_error'],
    ] as const) {
      const res = await postJson(`/api/simulations/${run.id}/analyses`, body);
      expect(res.status, JSON.stringify(body)).toBe(status);
      expect(apiErrorSchema.parse(await res.json()).error.code).toBe(code);
    }
  });
});

describe('chronological robustness of progression runs', () => {
  it('replays every block from fresh progression state and records the policy', async () => {
    seedSeries(db, MULTIPLIERS);
    const run = await createRun(request(plan()));
    const list = robustnessAnalysesListSchema.parse(
      await (await fetch(`${server.baseUrl}/api/simulations/${run.id}/robustness`)).json(),
    );
    expect(list.maxWindows).toBe(2);
    const analysis = await robustness(run.id, 2);
    const parsed = backtestRequestSchema.parse(request(plan()));
    const rounds = loadReplayRounds(db, parsed.dataset);
    expect(analysis.result).toEqual(
      runBlockRobustness(rounds, parsed.strategy, parsed.settings, { windows: 2 }, parsed.staking),
    );
    expect(analysis.result.staking?.statePolicy).toBe('reset_each_block');
    // The full-sample replay is the run's own stored result, progression summary included.
    expect(analysis.result.full.summary).toEqual(run.summary);
    expect(configOf('simulation_robustness_analyses', analysis.id).staking).toEqual(run.staking);
  });
});

describe('stored analyses of progression runs', () => {
  it('reports rows that contradict their run as server-side errors', async () => {
    seedSeries(db, MULTIPLIERS);
    const flat = await createRun(request());
    const prog = await createRun(request(plan()));
    expect(flat.datasetSha256).toBe(prog.datasetSha256);
    const a = await analyse(prog.id, { paths: 10, seed: 3 });
    const r = await robustness(prog.id, 2);
    const row = (table: string, id: number) =>
      db.prepare(`SELECT * FROM ${table} WHERE id = ?`).get(id) as Record<string, unknown>;
    const copyAnalysis = (replace: Record<string, unknown>) =>
      Number(
        db
          .prepare(
            `INSERT INTO simulation_analyses (simulation_run_id, status, method,
               algorithm_version, seed, paths, sample_size, dataset_sha256, config_json,
               summary_json, created_at, completed_at)
             VALUES (@simulation_run_id, 'completed', 'iid_bootstrap', @algorithm_version,
               @seed, @paths, @sample_size, @dataset_sha256, @config_json, @summary_json,
               @created_at, @completed_at)`,
          )
          .run({ ...row('simulation_analyses', a.id), ...replace }).lastInsertRowid,
      );
    const copyRobustness = (replace: Record<string, unknown>) =>
      Number(
        db
          .prepare(
            `INSERT INTO simulation_robustness_analyses (simulation_run_id, status, method,
               algorithm_version, result_schema_version, windows, sample_size, dataset_sha256,
               config_json, result_json, created_at, completed_at)
             VALUES (@simulation_run_id, 'completed', 'chronological_blocks',
               @algorithm_version, @result_schema_version, @windows, @sample_size,
               @dataset_sha256, @config_json, @result_json, @created_at, @completed_at)`,
          )
          .run({ ...row('simulation_robustness_analyses', r.id), ...replace }).lastInsertRowid,
      );

    // A progression analysis attached to the flat run on the same data (the fingerprint
    // trigger cannot tell them apart; the read check does).
    const onFlat = copyAnalysis({ simulation_run_id: flat.id });
    await expectStoredDataInvalid(`/api/simulations/${flat.id}/analyses/${onFlat}`);
    db.prepare('DELETE FROM simulation_analyses WHERE id = ?').run(onFlat);

    // A progression analysis whose snapshot lost the plan.
    const config = configOf('simulation_analyses', a.id);
    delete config.staking;
    const noPlan = copyAnalysis({ config_json: JSON.stringify(config) });
    await expectStoredDataInvalid(`/api/simulations/${prog.id}/analyses/${noPlan}`);
    db.prepare('DELETE FROM simulation_analyses WHERE id = ?').run(noPlan);

    // A progression analysis whose summary lost its staking metadata.
    const summary = JSON.parse(String(row('simulation_analyses', a.id).summary_json));
    delete summary.staking;
    const noMeta = copyAnalysis({ summary_json: JSON.stringify(summary) });
    await expectStoredDataInvalid(`/api/simulations/${prog.id}/analyses/${noMeta}`);
    await expectStoredDataInvalid(`/api/simulations/${prog.id}/analyses`);
    db.prepare('DELETE FROM simulation_analyses WHERE id = ?').run(noMeta);

    // Metadata naming a different progression.
    const other = JSON.parse(String(row('simulation_analyses', a.id).summary_json));
    other.staking.legs.A.configKey = progressionConfigKey(martingale(300));
    const wrongKey = copyAnalysis({ summary_json: JSON.stringify(other) });
    await expectStoredDataInvalid(`/api/simulations/${prog.id}/analyses/${wrongKey}`);
    db.prepare('DELETE FROM simulation_analyses WHERE id = ?').run(wrongKey);

    // Robustness: a progression result attached to the flat run, and a snapshot without plan.
    const rOnFlat = copyRobustness({ simulation_run_id: flat.id });
    await expectStoredDataInvalid(`/api/simulations/${flat.id}/robustness/${rOnFlat}`);
    db.prepare('DELETE FROM simulation_robustness_analyses WHERE id = ?').run(rOnFlat);
    const rConfig = configOf('simulation_robustness_analyses', r.id);
    delete rConfig.staking;
    const rNoPlan = copyRobustness({ config_json: JSON.stringify(rConfig) });
    await expectStoredDataInvalid(`/api/simulations/${prog.id}/robustness/${rNoPlan}`);
    db.prepare('DELETE FROM simulation_robustness_analyses WHERE id = ?').run(rNoPlan);

    // The genuine rows still read back.
    expect((await fetch(`${server.baseUrl}/api/simulations/${prog.id}/analyses`)).status).toBe(200);
    expect((await fetch(`${server.baseUrl}/api/simulations/${prog.id}/robustness`)).status).toBe(
      200,
    );
  });
});

describe('older databases', () => {
  it('reads analyses stored before migration 006 and analyses new progression runs', async () => {
    const legacy = openDatabase(':memory:');
    migrate(legacy, MIGRATIONS.slice(0, 5));
    seedSeries(legacy, MULTIPLIERS);
    const parsed = backtestRequestSchema.parse(request());
    const runId = insertLegacyRun(legacy, parsed);
    const runRow = legacy
      .prepare('SELECT summary_json, dataset_sha256 FROM simulation_runs WHERE id = ?')
      .get(runId) as { summary_json: string; dataset_sha256: string };
    const sample = loadReplayRounds(legacy, parsed.dataset).map((r) => r.multiplierX100);
    const summary = runBootstrap(
      sample,
      parsed.strategy,
      parsed.settings,
      { paths: 15, seed: 4 },
      JSON.parse(runRow.summary_json),
    );
    // An analysis row exactly as schema 5 stored it (no staking in the snapshot).
    const analysisId = Number(
      legacy
        .prepare(
          `INSERT INTO simulation_analyses (simulation_run_id, status, method, algorithm_version,
             seed, paths, sample_size, dataset_sha256, config_json, summary_json, created_at,
             completed_at)
           VALUES (?, 'completed', 'iid_bootstrap', ?, 4, 15, ?, ?, ?, ?, 'x', 'x')`,
        )
        .run(
          runId,
          summary.algorithmVersion,
          sample.length,
          runRow.dataset_sha256,
          JSON.stringify({
            strategy: parsed.strategy,
            settings: parsed.settings,
            datasetRequest: parsed.dataset,
          }),
          JSON.stringify(summary),
        ).lastInsertRowid,
    );
    const before = legacy.prepare('SELECT * FROM simulation_analyses').all();
    expect(migrate(legacy)).toEqual({ applied: [6, 7], currentVersion: 7 });
    expect(legacy.prepare('SELECT * FROM simulation_analyses').all()).toEqual(before);
    const legacyServer = await startTestServer(legacy, () => {});
    try {
      const res = await fetch(
        `${legacyServer.baseUrl}/api/simulations/${runId}/analyses/${analysisId}`,
      );
      expect(res.status, await res.clone().text()).toBe(200);
      expect(simulationAnalysisDtoSchema.parse(await res.json()).summary).toEqual(summary);
      // A new progression run on the migrated database can be analysed.
      const created = await postJson('/api/simulations', request(plan()), legacyServer.baseUrl);
      expect(created.status).toBe(201);
      const prog = simulationRunDtoSchema.parse(await created.json());
      expect(prog.staking).toEqual(plan() as StakingPlan);
      const analysed = await postJson(
        `/api/simulations/${prog.id}/analyses`,
        { paths: 10, seed: 1 },
        legacyServer.baseUrl,
      );
      expect(analysed.status).toBe(201);
    } finally {
      await legacyServer.close();
      legacy.close();
    }
  });
});
