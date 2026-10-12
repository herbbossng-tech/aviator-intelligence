import { act, cleanup, fireEvent, screen, within } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  ORDERING_RULE,
  runBacktest,
  runBootstrap,
  simulationAnalysisDtoSchema,
  simulationRunDtoSchema,
  type SimulationAnalysisDto,
  type SimulationRunDto,
  type SimulationSettings,
} from '@aviator/shared';
import { HEALTH_OK, renderAt } from './renderApp';

// SYNTHETIC TEST FIXTURES: runs and analyses computed by the real engines from invented rounds.

const at = (s: number) => new Date(Date.UTC(2026, 0, 1, 0, 0, s)).toISOString();
const MULTIPLIERS = [150, 200, 700, 100, 990, 205, 120, 340];
const STRATEGY = {
  schemaVersion: 1 as const,
  currency: 'NGN' as const,
  legs: {
    A: { label: 'Leg A', enabled: true, stakeMinor: 100, cashoutTargetX100: 200 },
    B: { label: 'Leg B', enabled: true, stakeMinor: 100, cashoutTargetX100: 600 },
  },
};
function settings(stopBelow: number | null = null): SimulationSettings {
  return {
    schemaVersion: 1,
    currency: 'NGN',
    startingBankrollMinor: 1_000,
    insufficientBankrollPolicy: 'skip_leg',
    risk: {
      stopBelowBankrollMinor: stopBelow,
      stopAtOrAboveBankrollMinor: null,
      maxDrawdownBps: null,
      maxRounds: null,
    },
  };
}

function makeRun(id: number, s = settings()): SimulationRunDto {
  const result = runBacktest(
    MULTIPLIERS.map((m, i) => ({ roundId: i + 1, multiplierX100: m, eventAt: at(i) })),
    STRATEGY,
    s,
  );
  const dataset = { source: 'synthetic-ui', importId: null, eventFrom: null, eventTo: null };
  return simulationRunDtoSchema.parse({
    id,
    status: 'completed',
    createdAt: '2026-02-01T00:00:00.000Z',
    completedAt: '2026-02-01T00:00:01.000Z',
    errorMessage: null,
    strategy: STRATEGY,
    settings: s,
    datasetRequest: dataset,
    dataset: {
      dataset,
      roundsMatching: 9,
      roundsEligible: MULTIPLIERS.length,
      excludedNoEventTime: 1,
      excludedSynthetic: 2,
      duplicateEventTimes: 0,
      nonCanonicalEventTimes: 0,
      firstEventAt: at(0),
      lastEventAt: at(MULTIPLIERS.length - 1),
      orderable: true,
      problem: null,
      orderingRule: ORDERING_RULE,
      maxRounds: 100_000,
    },
    datasetSha256: 'cd'.repeat(32),
    summary: result.summary,
  });
}

function makeAnalysis(
  run: SimulationRunDto,
  id: number,
  paths = 300,
  seed = 42,
): SimulationAnalysisDto {
  return simulationAnalysisDtoSchema.parse({
    id,
    simulationRunId: run.id,
    status: 'completed',
    createdAt: '2026-02-02T00:00:00.000Z',
    completedAt: '2026-02-02T00:00:01.000Z',
    algorithmVersion: 'iid-bootstrap/xoshiro128ss-fmix32/v1',
    seed,
    paths,
    datasetSha256: run.datasetSha256,
    summary: runBootstrap(MULTIPLIERS, run.strategy, run.settings, { paths, seed }, run.summary!),
  });
}

const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status });
const list = (items: SimulationAnalysisDto[], maxPaths = 2_000) => ({
  items,
  total: items.length,
  maxPaths,
  sampleSize: MULTIPLIERS.length,
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

describe('Uncertainty analysis page', () => {
  it('shows the sample, method and caution, with an honest empty state', async () => {
    const run = makeRun(7);
    stub({
      'GET /api/simulations/7': () => json(run),
      'GET /api/simulations/7/analyses': () => json(list([])),
    });
    renderAt('/simulations/7/uncertainty');
    expect(await screen.findByText('No analysis yet')).toBeTruthy();
    expect(screen.getByText(/not a prediction of future rounds/)).toBeTruthy();
    const sample = screen.getByRole('region', { name: 'Sample' });
    expect(within(sample).getByText('cd'.repeat(32))).toBeTruthy();
    expect(within(sample).getByText('Observed rounds (n)').nextSibling?.textContent).toBe('8');
    expect(screen.getByText(/add no new historical/)).toBeTruthy();
    expect(screen.getByText(/not confidence intervals/)).toBeTruthy();
  });

  it('shows resampled distributions, denominators and the observed run, distinguished', async () => {
    const run = makeRun(7);
    const analysis = makeAnalysis(run, 3);
    stub({
      'GET /api/simulations/7': () => json(run),
      'GET /api/simulations/7/analyses': () => json(list([analysis])),
    });
    renderAt('/simulations/7/uncertainty');
    const table = await screen.findByRole('table', {
      name: 'Observed value and distribution of resampled path values',
    });
    const ending = within(table).getByRole('rowheader', { name: 'Ending bankroll' }).closest('tr')!;
    const cells = within(ending)
      .getAllByRole('cell')
      .map((c) => c.textContent);
    const s = analysis.summary;
    expect(cells).toHaveLength(8); // observed, min, p05, p25, p50, p75, p95, max
    expect(cells[0]).toBe(`₦${(run.summary!.endingBankrollMinor / 100).toFixed(2)}`);
    expect(cells[4]).toBe(
      `₦${(s.endingBankrollMinor.quantiles.find((q) => q.levelBps === 5000)!.value / 100).toFixed(2)}`,
    );
    const n = s.netOutcome;
    const pct = (c: number) => `${((c / 300) * 100).toFixed(1)}%`;
    expect(screen.getByText('Ended below the start (net < 0)').nextSibling?.textContent).toBe(
      `${n.negative} of 300 (${pct(n.negative)})`,
    );
    expect(screen.getAllByText('Observed').length).toBeGreaterThan(1);
    expect(screen.getAllByText('Resampled').length).toBeGreaterThan(0);
    expect(screen.getByText('Lower bankroll stop').nextSibling?.textContent).toBe(
      'Not configured for this run',
    );
    expect(screen.getByText(/small_sample|Only 8 observed rounds/)).toBeTruthy();
    const stops = screen.getByRole('table', { name: 'Paths by stop reason' });
    expect(within(stops).getAllByRole('row')).toHaveLength(8);
  });

  it('shows the configured-boundary frequency only when a boundary is configured', async () => {
    const run = makeRun(8, settings(800));
    const analysis = makeAnalysis(run, 4);
    stub({
      'GET /api/simulations/8': () => json(run),
      'GET /api/simulations/8/analyses': () => json(list([analysis])),
    });
    renderAt('/simulations/8/uncertainty');
    const b = analysis.summary.configuredBoundaries.lowerBankrollStop!;
    expect(b.count).toBeGreaterThan(0);
    const row = await screen.findByText('Lower bankroll stop');
    expect(row.nextSibling?.textContent).toMatch(
      new RegExp(`^${b.count} of 300 .* of paths ended by falling below ₦8\\.00$`),
    );
    expect(screen.getByText(/not a probability of real-world loss/)).toBeTruthy();
  });

  it('validates settings locally, then runs and shows a new analysis', async () => {
    const run = makeRun(7);
    const created = makeAnalysis(run, 5, 120, 99);
    let release: (r: Response) => void = () => {};
    let posted: unknown;
    let analyses: SimulationAnalysisDto[] = [];
    const calls = stub({
      'GET /api/simulations/7': () => json(run),
      'GET /api/simulations/7/analyses': () => json(list(analyses, 250)),
      'POST /api/simulations/7/analyses': (_u, init) => {
        posted = JSON.parse(String(init?.body));
        return new Promise<Response>((resolve) => (release = resolve));
      },
    });
    renderAt('/simulations/7/uncertainty');
    const paths = (await screen.findByLabelText(/^Resampled paths/)) as HTMLInputElement;
    expect(paths.value).toBe('250'); // default capped by this sample's maximum
    fireEvent.change(paths, { target: { value: '251' } });
    fireEvent.change(screen.getByLabelText(/^Seed/), { target: { value: '-3' } });
    fireEvent.click(screen.getByRole('button', { name: 'Run analysis' }));
    expect(await screen.findByText('Enter a whole number from 1 to 250.')).toBeTruthy();
    expect(screen.getByText(/Enter a whole number from 0 to 9007199254740991/)).toBeTruthy();
    expect(calls.some((c) => c.init?.method === 'POST')).toBe(false);

    fireEvent.change(paths, { target: { value: '120' } });
    fireEvent.change(screen.getByLabelText(/^Seed/), { target: { value: '99' } });
    fireEvent.click(screen.getByRole('button', { name: 'Run analysis' }));
    expect(
      (screen.getByRole('button', { name: 'Resampling…' }) as HTMLButtonElement).disabled,
    ).toBe(true);
    analyses = [created];
    await act(async () => release(json(created, 201)));
    expect(posted).toEqual({ paths: 120, seed: 99 });
    expect(await screen.findByText(/Resampled results · analysis #5/)).toBeTruthy();
    expect((screen.getByLabelText(/^Seed/) as HTMLInputElement).value).toBe('99');
  });

  it('shows server rejections', async () => {
    const run = makeRun(7);
    stub({
      'GET /api/simulations/7': () => json(run),
      'GET /api/simulations/7/analyses': () => json(list([])),
      'POST /api/simulations/7/analyses': () =>
        json(
          {
            error: {
              code: 'dataset_changed',
              message: 'The rounds this run selected have changed since it ran.',
            },
          },
          409,
        ),
    });
    renderAt('/simulations/7/uncertainty');
    fireEvent.click(await screen.findByRole('button', { name: 'Run analysis' }));
    expect(await screen.findByText(/have changed since it ran/)).toBeTruthy();
  });

  it('refuses failed runs and shows unknown runs as errors', async () => {
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
    renderAt('/simulations/9/uncertainty');
    expect(await screen.findByText(/cannot be analysed/)).toBeTruthy();
    cleanup();
    stub({});
    renderAt('/simulations/abc/uncertainty');
    expect(await screen.findByText('No such simulation run.')).toBeTruthy();
  });

  it('is linked from a completed run', async () => {
    const run = makeRun(7);
    stub({
      'GET /api/simulations/7': () => json(run),
      'GET /api/simulations/7/ledger': () =>
        json({ runId: 7, currency: 'NGN', rounds: [], totalRounds: 0, limit: 50, offset: 0 }),
    });
    renderAt('/simulations/7');
    const link = await screen.findByRole('link', { name: 'Open uncertainty analysis' });
    expect(link.getAttribute('href')).toBe('/simulations/7/uncertainty');
  });
});
