import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  apiErrorSchema,
  backtestRequestSchema,
  ledgerResponseSchema,
  runBacktest,
  simulationRunDtoSchema,
  type SimulationRunDto,
} from '@aviator/shared';
import { openDatabase, type Db } from '../src/db/connection.js';
import { migrate } from '../src/db/migrate.js';
import { MIGRATIONS } from '../src/db/migrations/index.js';
import { insertRound } from '../src/db/repositories/rounds.js';
import { loadReplayRounds } from '../src/db/repositories/simulations.js';
import { createTestDb, insertLegacyRun, startTestServer } from './helpers.js';

// SYNTHETIC TEST FIXTURES: invented rounds in temporary in-memory databases only.
// Arithmetic examples, not recommendations; virtual money only.

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

const SOURCE = 'synthetic-progression';
const at = (second: number) => new Date(Date.UTC(2026, 0, 1) + second * 1000).toISOString();
const MULTIPLIERS = [150, 150, 150, 250, 600, 150, 120, 990, 150, 150, 300, 101];

function seedSeries(target: Db, ms: number[], start = 0) {
  ms.forEach((m, i) =>
    insertRound(target, {
      multiplierX100: m,
      source: SOURCE,
      sourceRoundId: `p-${start + i}`,
      observedAt: '2026-06-01T00:00:00.000Z',
      eventAt: at(start + i),
      importId: null,
      isSynthetic: false,
    }),
  );
}

const martingale = (limits: Record<string, unknown> = {}) => ({
  schemaVersion: 1,
  currency: 'NGN',
  winResetPolicy: 'reset_to_base',
  mode: 'martingale',
  baseStakeMinor: 50_000,
  multiplierX100: 200,
  limits: { maxSteps: 4, maxStakeMinor: null, maxCycleExposureMinor: 10_000_000, ...limits },
});

function request(staking: unknown = undefined, overrides: Record<string, unknown> = {}) {
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
      startingBankrollMinor: 2_000_000,
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
    ...overrides,
  };
}

const plan = (A: unknown = martingale(), B: unknown = null) => ({
  schemaVersion: 1,
  legs: { A, B },
});

const post = (body: unknown, base = server.baseUrl) =>
  fetch(`${base}/api/simulations`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });

async function createRun(body: unknown): Promise<SimulationRunDto> {
  const res = await post(body);
  expect(res.status, await res.clone().text()).toBe(201);
  return simulationRunDtoSchema.parse(await res.json());
}

async function ledger(runId: number) {
  const res = await fetch(`${server.baseUrl}/api/simulations/${runId}/ledger?limit=500`);
  expect(res.status, await res.clone().text()).toBe(200);
  return ledgerResponseSchema.parse(await res.json());
}

const count = (table: string) =>
  (db.prepare(`SELECT COUNT(*) AS n FROM ${table}`).get() as { n: number }).n;

describe('progression runs through the API', () => {
  it('stores the staking plan and a ledger that matches the shared engine exactly', async () => {
    seedSeries(db, MULTIPLIERS);
    const staking = plan(martingale(), null);
    const run = await createRun(request(staking));
    expect(run.staking).toEqual(staking);

    const parsed = backtestRequestSchema.parse(request(staking));
    const expected = runBacktest(
      loadReplayRounds(db, parsed.dataset),
      parsed.strategy,
      parsed.settings,
      parsed.staking,
    );
    expect(run.summary).toEqual(expected.summary);
    expect(run.summary?.progression?.legs.A).toMatchObject({ mode: 'martingale' });
    expect(run.summary?.progression?.legs.B).toBeNull();

    const page = await ledger(run.id);
    expect(page.rounds.map((r) => r.legs)).toEqual(expected.rounds.map((r) => r.legs));
    // Leg A carries progression fields; flat leg B has none.
    expect(page.rounds[3]!.legs[0]!.progression).toMatchObject({
      step: 3,
      requestedStakeMinor: 400_000,
      cycleLossBeforeMinor: 350_000,
      cycleLossAfterMinor: 0,
      skipReason: null,
    });
    expect(page.rounds.every((r) => r.legs[1]!.progression === undefined)).toBe(true);
  });

  it('records a permanent block on the ledger and keeps the other leg running', async () => {
    seedSeries(db, MULTIPLIERS);
    const run = await createRun(request(plan(martingale({ maxSteps: 2 }))));
    const page = await ledger(run.id);
    const a = page.rounds.map((r) => r.legs[0]!);
    expect(a[2]).toMatchObject({
      result: 'skipped',
      stakeMinor: 0,
      progression: { skipReason: 'max_steps_reached', active: false, requestedStakeMinor: null },
    });
    expect(a.slice(2).every((e) => e.result === 'skipped')).toBe(true);
    expect(page.rounds.every((r) => r.legs[1]!.result !== 'skipped')).toBe(true);
    expect(run.summary?.progression?.legs.A).toMatchObject({
      finalStatus: 'blocked',
      finalBlockReason: 'max_steps_reached',
      inactiveFromSequenceNo: 2,
    });
  });

  it('keeps flat runs exactly as before: no staking plan and no progression fields', async () => {
    seedSeries(db, MULTIPLIERS);
    const run = await createRun(request());
    expect(run.staking).toBeNull();
    expect(run.summary?.progression).toBeUndefined();
    const page = await ledger(run.id);
    expect(page.rounds.flatMap((r) => r.legs).every((l) => l.progression === undefined)).toBe(true);
    const nulls = db
      .prepare(
        `SELECT COUNT(*) AS n FROM ledger_entries WHERE progression_step IS NOT NULL
            OR skip_reason IS NOT NULL OR progression_active IS NOT NULL`,
      )
      .get() as { n: number };
    expect(nulls.n).toBe(0);
    expect(
      (db.prepare('SELECT staking_json FROM simulation_runs').get() as { staking_json: unknown })
        .staking_json,
    ).toBeNull();
  });

  it('is reproducible: the same request gives the same summary and ledger', async () => {
    seedSeries(db, MULTIPLIERS);
    const staking = plan(martingale(), { ...martingale({ maxSteps: 3 }), baseStakeMinor: 50_000 });
    const a = await createRun(request(staking));
    const b = await createRun(request(staking));
    expect(b.summary).toEqual(a.summary);
    expect(b.datasetSha256).toBe(a.datasetSha256);
    expect((await ledger(b.id)).rounds).toEqual((await ledger(a.id)).rounds);
  });

  it('keeps the dataset fingerprint independent of the staking plan', async () => {
    seedSeries(db, MULTIPLIERS);
    const flat = await createRun(request());
    const prog = await createRun(request(plan()));
    expect(prog.datasetSha256).toBe(flat.datasetSha256);
    expect(prog.summary?.progression?.legs.A?.configKey).toMatch(/^fnv1a64:/);
  });

  it('validates staking plans strictly (400) and stores nothing', async () => {
    seedSeries(db, MULTIPLIERS);
    const disabledB = request(plan(null, martingale()), {});
    (disabledB.strategy.legs.B as { enabled: boolean }).enabled = false;
    for (const body of [
      request(plan({ ...martingale(), baseStakeMinor: 60_000 })),
      request(plan({ ...martingale(), currency: 'USD' })),
      request(plan({ ...martingale(), mode: 'reverse_martingale' })),
      request(plan({ ...martingale(), limits: { maxSteps: 4, maxStakeMinor: null } })),
      request({ schemaVersion: 1, legs: { A: null } }),
      request({ schemaVersion: 1, legs: { A: null, B: null }, extra: true }),
      disabledB,
    ]) {
      const res = await post(body);
      expect(res.status, JSON.stringify(body.staking)).toBe(400);
      expect(apiErrorSchema.parse(await res.json()).error.code).toBe('validation_error');
    }
    expect(count('simulation_runs')).toBe(0);
  });

  it('rolls back a failed write and records the staking plan on the failed run', async () => {
    seedSeries(db, MULTIPLIERS);
    db.exec(`CREATE TRIGGER fail_ledger BEFORE INSERT ON ledger_entries
             BEGIN SELECT RAISE(ABORT, 'injected'); END;`);
    expect((await post(request(plan()))).status).toBe(500);
    expect(count('ledger_entries')).toBe(0);
    const row = db.prepare('SELECT status, staking_json FROM simulation_runs').get() as {
      status: string;
      staking_json: string;
    };
    expect(row.status).toBe('failed');
    expect(JSON.parse(row.staking_json)).toEqual(plan());
  });
});

describe('stored progression data', () => {
  it('rejects inconsistent progression fields and changes to a stored plan', async () => {
    seedSeries(db, MULTIPLIERS);
    const flat = await createRun(request());
    const prog = await createRun(request(plan()));
    const insert = (runId: number, fields: Record<string, unknown>) =>
      db
        .prepare(
          `INSERT INTO ledger_entries (simulation_run_id, round_id, sequence_no, leg_key, stake_minor,
             cashout_target_x100, gross_return_minor, net_minor, result, created_at,
             progression_step, requested_stake_minor, cycle_loss_before_minor,
             cycle_loss_after_minor, skip_reason, progression_active)
           VALUES (@run, 1, 999, 'A', @stake, 200, @gross, @net, @result, 'x', @step, @requested,
             @before, @after, @reason, @active)`,
        )
        .run({
          run: runId,
          stake: 100,
          gross: 0,
          net: -100,
          result: 'loss',
          step: 0,
          requested: 100,
          before: 0,
          after: 100,
          reason: null,
          active: 1,
          ...fields,
        });
    // On a flat run, no progression fields at all.
    expect(() => insert(flat.id, {})).toThrow(/inconsistent/);
    // Inconsistent with the result.
    expect(() => insert(prog.id, { after: 50 })).toThrow(/inconsistent/);
    expect(() => insert(prog.id, { requested: 200 })).toThrow(/inconsistent/);
    expect(() => insert(prog.id, { active: 0 })).toThrow(/inconsistent/);
    expect(() =>
      insert(prog.id, { result: 'skipped', stake: 0, net: 0, after: 0, reason: null }),
    ).toThrow(/inconsistent/);
    expect(() =>
      insert(prog.id, {
        result: 'skipped',
        stake: 0,
        net: 0,
        after: 0,
        reason: 'max_steps_reached',
        active: 1,
      }),
    ).toThrow(/inconsistent/);
    expect(() =>
      insert(prog.id, {
        result: 'skipped',
        stake: 0,
        net: 0,
        after: 0,
        reason: 'insufficient_bankroll',
        requested: null,
      }),
    ).toThrow(/inconsistent/);
    // An unknown reason on an otherwise consistent skipped row fails the column CHECK.
    expect(() =>
      insert(prog.id, {
        result: 'skipped',
        stake: 0,
        net: 0,
        after: 0,
        reason: 'bad_reason',
        active: 0,
      }),
    ).toThrow(/CHECK/);
    // A consistent row is accepted.
    expect(() => insert(prog.id, {})).not.toThrow();
    expect(() =>
      db.prepare('UPDATE simulation_runs SET staking_json = NULL WHERE id = ?').run(prog.id),
    ).toThrow(/cannot be changed/);
  });

  it('reports unreadable stored progression data as a server-side error', async () => {
    seedSeries(db, MULTIPLIERS);
    const run = await createRun(request(plan()));
    // A copy of the run whose stored plan has no progression for leg A, while its copied
    // ledger rows for leg A carry progression fields.
    const row = db.prepare('SELECT * FROM simulation_runs WHERE id = ?').get(run.id) as Record<
      string,
      unknown
    >;
    const id = Number(
      db
        .prepare(
          `INSERT INTO simulation_runs (strategy_snapshot_json, settings_json, dataset_json,
             currency, starting_bankroll_minor, status, ending_bankroll_minor, rounds_processed,
             created_at, started_at, completed_at, summary_json, stop_reason, dataset_sha256,
             staking_json)
           VALUES (@strategy_snapshot_json, @settings_json, @dataset_json, @currency,
             @starting_bankroll_minor, 'completed', @ending_bankroll_minor, @rounds_processed,
             @created_at, @started_at, @completed_at, @summary_json, @stop_reason, @dataset_sha256,
             @staking)`,
        )
        .run({ ...row, staking: JSON.stringify({ schemaVersion: 1, legs: { A: null, B: null } }) })
        .lastInsertRowid,
    );
    db.prepare(
      `INSERT INTO ledger_entries (simulation_run_id, round_id, sequence_no, leg_key, stake_minor,
         cashout_target_x100, gross_return_minor, net_minor, result, created_at,
         round_multiplier_x100, bankroll_before_minor, bankroll_after_minor, progression_step,
         requested_stake_minor, cycle_loss_before_minor, cycle_loss_after_minor, skip_reason,
         progression_active)
       SELECT ?, round_id, sequence_no, leg_key, stake_minor, cashout_target_x100,
         gross_return_minor, net_minor, result, created_at, round_multiplier_x100,
         bankroll_before_minor, bankroll_after_minor, progression_step, requested_stake_minor,
         cycle_loss_before_minor, cycle_loss_after_minor, skip_reason, progression_active
       FROM ledger_entries WHERE simulation_run_id = ? ORDER BY id`,
    ).run(id, run.id);
    const res = await fetch(`${server.baseUrl}/api/simulations/${id}/ledger?limit=500`);
    expect(res.status).toBe(500);
    expect(apiErrorSchema.parse(await res.json()).error).toMatchObject({
      code: 'stored_data_invalid',
      details: { simulationRunId: id },
    });
  });

  it('reports a stored plan that contradicts the stored strategy or summary', async () => {
    seedSeries(db, MULTIPLIERS);
    const flat = await createRun(request());
    const prog = await createRun(request(plan()));
    const rowOf = (id: number) =>
      db.prepare('SELECT * FROM simulation_runs WHERE id = ?').get(id) as Record<string, unknown>;
    // A copy of a stored run with some columns replaced, as if written outside the app.
    const copy = (id: number, replace: Record<string, unknown>) =>
      Number(
        db
          .prepare(
            `INSERT INTO simulation_runs (strategy_snapshot_json, settings_json, dataset_json,
               currency, starting_bankroll_minor, status, ending_bankroll_minor, rounds_processed,
               created_at, started_at, completed_at, summary_json, stop_reason, dataset_sha256,
               staking_json)
             VALUES (@strategy_snapshot_json, @settings_json, @dataset_json, @currency,
               @starting_bankroll_minor, 'completed', @ending_bankroll_minor, @rounds_processed,
               @created_at, @started_at, @completed_at, @summary_json, @stop_reason,
               @dataset_sha256, @staking_json)`,
          )
          .run({ ...rowOf(id), ...replace }).lastInsertRowid,
      );
    const expectUnreadable = async (id: number) => {
      const res = await fetch(`${server.baseUrl}/api/simulations/${id}`);
      expect(res.status).toBe(500);
      expect(apiErrorSchema.parse(await res.json()).error).toMatchObject({
        code: 'stored_data_invalid',
        details: { simulationRunId: id },
      });
    };
    const progRow = rowOf(prog.id);

    // An unchanged copy reads back normally.
    const same = copy(prog.id, {});
    expect((await fetch(`${server.baseUrl}/api/simulations/${same}`)).status).toBe(200);
    // A flat run's summary (no progression) under a staking plan.
    await expectUnreadable(copy(flat.id, { staking_json: progRow.staking_json }));
    // A progression summary on a run without a plan.
    await expectUnreadable(copy(prog.id, { staking_json: null }));
    // A valid plan, but not the one the summary describes (different configuration key).
    await expectUnreadable(
      copy(prog.id, {
        staking_json: JSON.stringify(plan(martingale(), null)).replace(
          '"multiplierX100":200',
          '"multiplierX100":300',
        ),
      }),
    );
    // The summary reports leg B as flat, but the plan gives it a progression.
    const legB = { ...martingale(), baseStakeMinor: 50_000 };
    await expectUnreadable(
      copy(prog.id, { staking_json: JSON.stringify(plan(martingale(), legB)) }),
    );
    // A plan that no longer fits the stored strategy (base stake differs from the leg stake).
    const strategy = JSON.parse(String(progRow.strategy_snapshot_json)) as {
      legs: { A: { stakeMinor: number } };
    };
    strategy.legs.A.stakeMinor = 60_000;
    await expectUnreadable(copy(prog.id, { strategy_snapshot_json: JSON.stringify(strategy) }));
    // The list endpoint refuses the same way rather than showing a contradictory run.
    expect((await fetch(`${server.baseUrl}/api/simulations?limit=100`)).status).toBe(500);
  });

  it('reports a malformed stored staking plan as a server-side error', async () => {
    seedSeries(db, MULTIPLIERS);
    const run = await createRun(request(plan()));
    const row = db.prepare('SELECT * FROM simulation_runs WHERE id = ?').get(run.id) as Record<
      string,
      unknown
    >;
    const bad = { ...plan(), legs: { A: { ...martingale(), multiplierX100: 5 }, B: null } };
    const id = Number(
      db
        .prepare(
          `INSERT INTO simulation_runs (strategy_snapshot_json, settings_json, dataset_json,
             currency, starting_bankroll_minor, status, ending_bankroll_minor, rounds_processed,
             created_at, started_at, completed_at, summary_json, stop_reason, dataset_sha256,
             staking_json)
           VALUES (@strategy_snapshot_json, @settings_json, @dataset_json, @currency,
             @starting_bankroll_minor, 'completed', @ending_bankroll_minor, @rounds_processed,
             @created_at, @started_at, @completed_at, @summary_json, @stop_reason, @dataset_sha256,
             @staking)`,
        )
        .run({ ...row, staking: JSON.stringify(bad) }).lastInsertRowid,
    );
    const res = await fetch(`${server.baseUrl}/api/simulations/${id}`);
    expect(res.status).toBe(500);
    expect(apiErrorSchema.parse(await res.json()).error).toMatchObject({
      code: 'stored_data_invalid',
      details: { simulationRunId: id },
    });
  });
});

describe('migration 006', () => {
  it('migrates a schema-5 database with existing runs and analyses without changing them', async () => {
    const legacy = openDatabase(':memory:');
    migrate(legacy, MIGRATIONS.slice(0, 5));
    seedSeries(legacy, [
      ...MULTIPLIERS,
      ...MULTIPLIERS,
      ...MULTIPLIERS,
      ...MULTIPLIERS,
      ...MULTIPLIERS,
      ...MULTIPLIERS,
    ]);
    const runId = insertLegacyRun(legacy, backtestRequestSchema.parse(request()));
    const ledgerBefore = legacy.prepare('SELECT COUNT(*) AS n FROM ledger_entries').get();
    expect(migrate(legacy)).toEqual({ applied: [6], currentVersion: 6 });
    expect(legacy.prepare('SELECT COUNT(*) AS n FROM ledger_entries').get()).toEqual(ledgerBefore);
    const legacyServer = await startTestServer(legacy);
    try {
      const res = await fetch(`${legacyServer.baseUrl}/api/simulations/${runId}`);
      const run = simulationRunDtoSchema.parse(await res.json());
      expect(run.staking).toBeNull();
      const page = ledgerResponseSchema.parse(
        await (await fetch(`${legacyServer.baseUrl}/api/simulations/${runId}/ledger`)).json(),
      );
      expect(page.rounds[0]!.legs.every((l) => l.progression === undefined)).toBe(true);
      // Older runs can still be analysed.
      const analysis = await fetch(`${legacyServer.baseUrl}/api/simulations/${runId}/robustness`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ windows: 2 }),
      });
      expect(analysis.status).toBe(201);
    } finally {
      await legacyServer.close();
      legacy.close();
    }
  });
});
