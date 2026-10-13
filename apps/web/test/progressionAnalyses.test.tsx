import { cleanup, screen, within } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  ORDERING_RULE,
  ROBUSTNESS_ALGORITHM_VERSION,
  ROBUSTNESS_RESULT_SCHEMA_VERSION,
  robustnessAnalysisDtoSchema,
  runBacktest,
  runBlockRobustness,
  runBootstrap,
  simulationAnalysisDtoSchema,
  simulationRunDtoSchema,
  type SimulationRunDto,
  type StakingPlan,
} from '@aviator/shared';
import {
  BOOTSTRAP_PROGRESSION_NOTE,
  ROBUSTNESS_PROGRESSION_NOTE,
} from '../src/pages/simulations/display';
import { HEALTH_OK, renderAt } from './renderApp';

// SYNTHETIC TEST FIXTURES: runs and analyses computed by the real engines from invented
// rounds. Virtual money only; the progressions are arithmetic examples, not recommendations.

const at = (s: number) => new Date(Date.UTC(2026, 0, 1, 0, 0, s)).toISOString();
const ROUNDS = Array.from({ length: 90 }, (_, i) => ({
  roundId: 100 + i,
  multiplierX100: [150, 120, 700, 110, 990, 130, 120, 340, 101, 110][i % 10]!,
  eventAt: at(i),
}));
const STRATEGY = {
  schemaVersion: 1 as const,
  currency: 'NGN' as const,
  legs: {
    A: { label: 'Leg A', enabled: true, stakeMinor: 100, cashoutTargetX100: 200 },
    B: { label: 'Leg B', enabled: true, stakeMinor: 100, cashoutTargetX100: 600 },
  },
};
const SETTINGS = {
  schemaVersion: 1 as const,
  currency: 'NGN' as const,
  startingBankrollMinor: 2_000,
  insufficientBankrollPolicy: 'skip_leg' as const,
  risk: {
    stopBelowBankrollMinor: null,
    stopAtOrAboveBankrollMinor: null,
    maxDrawdownBps: null,
    maxRounds: null,
  },
};
// Leg A: Martingale with two steps, so two consecutive losses stop it for the replay.
const PLAN: StakingPlan = {
  schemaVersion: 1,
  legs: {
    A: {
      schemaVersion: 1,
      currency: 'NGN',
      winResetPolicy: 'reset_to_base',
      mode: 'martingale',
      baseStakeMinor: 100,
      multiplierX100: 200,
      limits: { maxSteps: 2, maxStakeMinor: null, maxCycleExposureMinor: 10_000 },
    },
    B: null,
  },
};

function makeRun(id: number): SimulationRunDto {
  const dataset = { source: 'synthetic-ui', importId: null, eventFrom: null, eventTo: null };
  return simulationRunDtoSchema.parse({
    id,
    status: 'completed',
    createdAt: '2026-02-01T00:00:00.000Z',
    completedAt: '2026-02-01T00:00:01.000Z',
    errorMessage: null,
    strategy: STRATEGY,
    settings: SETTINGS,
    datasetRequest: dataset,
    dataset: {
      dataset,
      roundsMatching: ROUNDS.length,
      roundsEligible: ROUNDS.length,
      excludedNoEventTime: 0,
      excludedSynthetic: 0,
      duplicateEventTimes: 0,
      nonCanonicalEventTimes: 0,
      firstEventAt: at(0),
      lastEventAt: at(ROUNDS.length - 1),
      orderable: true,
      problem: null,
      orderingRule: ORDERING_RULE,
      maxRounds: 100_000,
    },
    datasetSha256: 'ef'.repeat(32),
    summary: runBacktest(ROUNDS, STRATEGY, SETTINGS, PLAN).summary,
    staking: PLAN,
  });
}

const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status });

function stub(routes: Record<string, () => Response>) {
  vi.stubGlobal(
    'fetch',
    vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = new URL(typeof input === 'string' ? input : input.toString(), 'http://localhost');
      const handler = routes[`${init?.method ?? 'GET'} ${url.pathname}`];
      if (handler) return handler();
      if (url.pathname === '/api/health') return json(HEALTH_OK);
      return json({ error: { code: 'not_found', message: 'nope' } }, 404);
    }),
  );
}

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

const row = (label: string) => screen.getByText(label).nextSibling?.textContent;

describe('Uncertainty analysis of a progression run', () => {
  it('shows the plan, the restart policy and per-leg progression figures', async () => {
    const run = makeRun(7);
    const summary = runBootstrap(
      ROUNDS.map((r) => r.multiplierX100),
      STRATEGY,
      SETTINGS,
      { paths: 50, seed: 12 },
      run.summary!,
      PLAN,
    );
    const analysis = simulationAnalysisDtoSchema.parse({
      id: 3,
      simulationRunId: 7,
      status: 'completed',
      createdAt: '2026-02-02T00:00:00.000Z',
      completedAt: '2026-02-02T00:00:01.000Z',
      algorithmVersion: summary.algorithmVersion,
      seed: 12,
      paths: 50,
      datasetSha256: run.datasetSha256,
      summary,
    });
    stub({
      'GET /api/simulations/7': () => json(run),
      'GET /api/simulations/7/analyses': () =>
        json({ items: [analysis], total: 1, maxPaths: 2_000, sampleSize: ROUNDS.length }),
    });
    renderAt('/simulations/7/uncertainty');
    expect(await screen.findByText(BOOTSTRAP_PROGRESSION_NOTE)).toBeTruthy();
    expect(BOOTSTRAP_PROGRESSION_NOTE).toMatch(/does not create an edge or guarantee recovery/);
    expect(row('Leg A staking')).toBe(
      'Martingale ×2.00 · base ₦1.00 · up to 2 step(s) · max cycle exposure ₦100.00',
    );
    expect(row('Leg B staking')).toBe('Flat (same stake every round)');

    const section = await screen.findByRole('region', {
      name: 'Staking progressions on resampled paths',
    });
    const leg = summary.staking!.legs.A!;
    expect(leg.pathsStoppedByLimit).toBeGreaterThan(0); // the fixture exercises the limit
    expect(
      within(section).getByText('Leg A: paths where a limit stopped it').nextSibling?.textContent,
    ).toMatch(new RegExp(`^${leg.pathsStoppedByLimit} of 50 `));
    expect(
      within(section).getByText('Leg A: paths with a stake the bankroll could not fund').nextSibling
        ?.textContent,
    ).toMatch(new RegExp(`^${leg.pathsWithBankrollSkips} of 50 `));
    expect(within(section).getByText('Leg B').nextSibling?.textContent).toBe('Flat stakes');
    expect(within(section).getByText(/Martingale · fnv1a64:/)).toBeTruthy();
  });
});

describe('Robustness analysis of a progression run', () => {
  it('states that progressions restart in every block and shows where limits stopped a leg', async () => {
    const run = makeRun(8);
    const result = runBlockRobustness(ROUNDS, STRATEGY, SETTINGS, { windows: 3 }, PLAN);
    const analysis = robustnessAnalysisDtoSchema.parse({
      id: 4,
      simulationRunId: 8,
      status: 'completed',
      createdAt: '2026-02-02T00:00:00.000Z',
      completedAt: '2026-02-02T00:00:01.000Z',
      algorithmVersion: ROBUSTNESS_ALGORITHM_VERSION,
      resultSchemaVersion: ROBUSTNESS_RESULT_SCHEMA_VERSION,
      windows: 3,
      sampleSize: ROUNDS.length,
      datasetSha256: run.datasetSha256,
      result,
    });
    stub({
      'GET /api/simulations/8': () => json(run),
      'GET /api/simulations/8/robustness': () =>
        json({
          items: [analysis],
          total: 1,
          limit: 50,
          offset: 0,
          maxWindows: 3,
          sampleSize: ROUNDS.length,
        }),
    });
    renderAt('/simulations/8/robustness');
    expect(await screen.findByText(ROBUSTNESS_PROGRESSION_NOTE)).toBeTruthy();
    expect(await screen.findByText('Progression state')).toBeTruthy();
    expect(row('Progression state')).toBe(
      'Restarted at the first step in every block and in the full sample',
    );
    expect(row('Leg A progression key')).toBe(result.staking!.legs.A!.configKey);
    expect(row('Leg B progression key')).toBe('Flat stakes');

    const table = screen.getByRole('table', { name: 'Chronological block results' });
    const rows = within(table).getAllByRole('row').slice(1);
    expect(rows).toHaveLength(3);
    result.blocks.forEach((block, i) => {
      const reason = block.summary.progression!.legs.A!.finalBlockReason;
      const cell = within(rows[i]!).queryByText(/^Leg A: /);
      if (reason === null) expect(cell).toBeNull();
      else expect(cell?.textContent).toMatch(/limit reached; leg stopped|above the maximum/);
    });
    expect(
      result.blocks.some((b) => b.summary.progression!.legs.A!.finalBlockReason !== null),
    ).toBe(true);
  });
});
