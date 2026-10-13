import { act, cleanup, fireEvent, screen, within } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  ORDERING_RULE,
  ROBUSTNESS_ALGORITHM_VERSION,
  ROBUSTNESS_RESULT_SCHEMA_VERSION,
  robustnessAnalysisDtoSchema,
  runBacktest,
  runBlockRobustness,
  simulationRunDtoSchema,
  type RobustnessAnalysisDto,
  type SimulationRunDto,
} from '@aviator/shared';
import { ROBUSTNESS_CAUTION } from '../src/pages/simulations/RobustnessPage';
import { HEALTH_OK, renderAt } from './renderApp';

// SYNTHETIC TEST FIXTURES: runs and analyses computed by the real engines from invented rounds.

const at = (s: number) => new Date(Date.UTC(2026, 0, 1, 0, 0, s)).toISOString();
const ROUNDS = Array.from({ length: 90 }, (_, i) => ({
  roundId: 100 + i,
  multiplierX100: [150, 200, 700, 100, 990, 205, 120, 340, 600, 110][i % 10]!,
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
  startingBankrollMinor: 50_000,
  insufficientBankrollPolicy: 'skip_leg' as const,
  risk: {
    stopBelowBankrollMinor: null,
    stopAtOrAboveBankrollMinor: null,
    maxDrawdownBps: null,
    maxRounds: null,
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
      roundsMatching: 91,
      roundsEligible: ROUNDS.length,
      excludedNoEventTime: 1,
      excludedSynthetic: 2,
      duplicateEventTimes: 0,
      nonCanonicalEventTimes: 0,
      firstEventAt: at(0),
      lastEventAt: at(ROUNDS.length - 1),
      orderable: true,
      problem: null,
      orderingRule: ORDERING_RULE,
      maxRounds: 100_000,
    },
    datasetSha256: 'cd'.repeat(32),
    summary: runBacktest(ROUNDS, STRATEGY, SETTINGS).summary,
  });
}

function makeAnalysis(run: SimulationRunDto, id: number, windows = 3): RobustnessAnalysisDto {
  return robustnessAnalysisDtoSchema.parse({
    id,
    simulationRunId: run.id,
    status: 'completed',
    createdAt: '2026-02-02T00:00:00.000Z',
    completedAt: '2026-02-02T00:00:01.000Z',
    algorithmVersion: ROBUSTNESS_ALGORITHM_VERSION,
    resultSchemaVersion: ROBUSTNESS_RESULT_SCHEMA_VERSION,
    windows,
    sampleSize: ROUNDS.length,
    datasetSha256: run.datasetSha256,
    result: runBlockRobustness(ROUNDS, STRATEGY, SETTINGS, { windows }),
  });
}

const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status });
const list = (items: RobustnessAnalysisDto[], maxWindows = 3, sampleSize = ROUNDS.length) => ({
  items,
  total: items.length,
  limit: 50,
  offset: 0,
  maxWindows,
  sampleSize,
});

type Handler = (url: URL, init?: RequestInit) => Response | Promise<Response>;
function stub(routes: Record<string, Handler>) {
  const calls: { url: URL; init?: RequestInit | undefined }[] = [];
  vi.stubGlobal(
    'fetch',
    vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = new URL(typeof input === 'string' ? input : input.toString(), 'http://localhost');
      calls.push({ url, init });
      const handler = routes[`${init?.method ?? 'GET'} ${url.pathname}`];
      if (handler) return handler(url, init);
      if (url.pathname === '/api/health') return json(HEALTH_OK);
      return json({ error: { code: 'not_found', message: 'nope' } }, 404);
    }),
  );
  return calls;
}

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe('Robustness analysis page', () => {
  it('shows a loading state, then the caution, dataset, method and an honest empty state', async () => {
    const run = makeRun(7);
    let releaseRun: (r: Response) => void = () => {};
    stub({
      'GET /api/simulations/7': () => new Promise<Response>((resolve) => (releaseRun = resolve)),
      'GET /api/simulations/7/robustness': () => json(list([])),
    });
    renderAt('/simulations/7/robustness');
    expect(await screen.findByText('Loading run…')).toBeTruthy();
    await act(async () => releaseRun(json(run)));
    expect(await screen.findByText('No robustness analysis yet')).toBeTruthy();
    expect(screen.getByRole('note').textContent).toBe(ROBUSTNESS_CAUTION);
    expect(ROBUSTNESS_CAUTION).toMatch(/not out-of-sample validation/);
    expect(ROBUSTNESS_CAUTION).toMatch(/not evidence that a configuration is profitable/);
    expect(screen.getByText('cd'.repeat(32))).toBeTruthy();
    expect(
      screen.getByText(/not added together and do not sum to the full-sample result/),
    ).toBeTruthy();
  });

  it('shows the full sample and every block separately, with boundaries and provenance', async () => {
    const run = makeRun(7);
    const analysis = makeAnalysis(run, 4, 3);
    stub({
      'GET /api/simulations/7': () => json(run),
      'GET /api/simulations/7/robustness': () => json(list([analysis])),
    });
    renderAt('/simulations/7/robustness');
    expect(await screen.findByRole('heading', { name: 'Analysis #4' })).toBeTruthy();
    expect(screen.getByText(ROBUSTNESS_ALGORITHM_VERSION)).toBeTruthy();
    expect(screen.getByRole('heading', { name: 'Full sample' })).toBeTruthy();
    expect(screen.getByText('90 of 90')).toBeTruthy();

    const table = screen.getByRole('table', { name: 'Chronological block results' });
    expect(table.getAttribute('aria-describedby')).toBe('block-note');
    const rows = within(table).getAllByRole('row').slice(1);
    expect(rows).toHaveLength(3);
    const blocks = analysis.result.blocks;
    // Positions and round ids at each boundary, exactly as returned.
    expect(rows[0]!.textContent).toContain('30 (1–30)');
    expect(rows[1]!.textContent).toContain('30 (31–60)');
    expect(rows[2]!.textContent).toContain(
      `ids ${blocks[2]!.firstRoundId}–${blocks[2]!.lastRoundId}`,
    );
    expect(screen.getByText(/Each row is a separate replay of one period/)).toBeTruthy();
  });

  it('offers only the block counts the sample allows, then runs and shows the new analysis', async () => {
    const run = makeRun(7);
    const created = makeAnalysis(run, 5, 2);
    let release: (r: Response) => void = () => {};
    let posted: unknown;
    let saved: RobustnessAnalysisDto[] = [];
    stub({
      'GET /api/simulations/7': () => json(run),
      'GET /api/simulations/7/robustness': () => json(list(saved, 3)),
      'POST /api/simulations/7/robustness': (_u, init) => {
        posted = JSON.parse(String(init?.body));
        return new Promise<Response>((resolve) => (release = resolve));
      },
    });
    renderAt('/simulations/7/robustness');
    const select = (await screen.findByLabelText(/^Chronological blocks/)) as HTMLSelectElement;
    expect([...select.options].map((o) => o.value)).toEqual(['2', '3']);
    expect(select.value).toBe('3');
    fireEvent.change(select, { target: { value: '2' } });
    fireEvent.click(screen.getByRole('button', { name: 'Run analysis' }));
    expect((screen.getByRole('button', { name: 'Replaying…' }) as HTMLButtonElement).disabled).toBe(
      true,
    );
    saved = [created];
    await act(async () => release(json(created, 201)));
    expect(posted).toEqual({ windows: 2 });
    expect(await screen.findByRole('heading', { name: 'Analysis #5' })).toBeTruthy();
  });

  it('shows server rejections such as workload or sample limits', async () => {
    const run = makeRun(7);
    stub({
      'GET /api/simulations/7': () => json(run),
      'GET /api/simulations/7/robustness': () => json(list([])),
      'POST /api/simulations/7/robustness': () =>
        json(
          {
            error: {
              code: 'robustness_sample_too_small',
              message: "This run's sample has 90 rounds, so at most 3 blocks are possible.",
            },
          },
          422,
        ),
    });
    renderAt('/simulations/7/robustness');
    fireEvent.click(await screen.findByRole('button', { name: 'Run analysis' }));
    expect(await screen.findByText(/at most 3 blocks are possible/)).toBeTruthy();
  });

  it('explains when the sample is too small for any blocks, without a form', async () => {
    const run = makeRun(7);
    stub({
      'GET /api/simulations/7': () => json(run),
      'GET /api/simulations/7/robustness': () => json(list([], 0)),
    });
    renderAt('/simulations/7/robustness');
    expect(await screen.findByText(/at least 60 are needed for 2 blocks of 30/)).toBeTruthy();
    expect(screen.queryByRole('button', { name: 'Run analysis' })).toBeNull();
  });

  it('reopens a saved analysis from the list', async () => {
    const run = makeRun(7);
    const older = makeAnalysis(run, 2, 2);
    const newer = makeAnalysis(run, 3, 3);
    stub({
      'GET /api/simulations/7': () => json(run),
      'GET /api/simulations/7/robustness': () => json(list([newer, older])),
    });
    renderAt('/simulations/7/robustness');
    expect(await screen.findByRole('heading', { name: 'Analysis #3' })).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Show #2' }));
    expect(await screen.findByRole('heading', { name: 'Analysis #2' })).toBeTruthy();
    const table = screen.getByRole('table', { name: 'Chronological block results' });
    expect(within(table).getAllByRole('row')).toHaveLength(3);
  });

  it('shows errors for failed runs, unknown runs and a failing list', async () => {
    const failed = simulationRunDtoSchema.parse({
      ...makeRun(9),
      status: 'failed',
      completedAt: null,
      errorMessage: 'x',
      dataset: null,
      datasetSha256: null,
      summary: null,
    });
    stub({ 'GET /api/simulations/9': () => json(failed) });
    renderAt('/simulations/9/robustness');
    expect(await screen.findByText(/cannot be analysed/)).toBeTruthy();
    cleanup();
    stub({});
    renderAt('/simulations/abc/robustness');
    expect(await screen.findByText('No such simulation run.')).toBeTruthy();
    cleanup();
    stub({
      'GET /api/simulations/7': () => json(makeRun(7)),
      'GET /api/simulations/7/robustness': () =>
        json(
          {
            error: {
              code: 'stored_data_invalid',
              message: 'A stored record could not be read safely.',
            },
          },
          500,
        ),
    });
    renderAt('/simulations/7/robustness');
    expect(await screen.findByText(/could not be read safely/)).toBeTruthy();
  });

  it('is linked from a completed run', async () => {
    const run = makeRun(7);
    stub({
      'GET /api/simulations/7': () => json(run),
      'GET /api/simulations/7/ledger': () =>
        json({ runId: 7, currency: 'NGN', rounds: [], totalRounds: 0, limit: 50, offset: 0 }),
    });
    renderAt('/simulations/7');
    const link = await screen.findByRole('link', { name: 'Open robustness analysis' });
    expect(link.getAttribute('href')).toBe('/simulations/7/robustness');
  });
});
