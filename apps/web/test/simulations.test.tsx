import { act, cleanup, fireEvent, screen, within } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  ORDERING_RULE,
  runBacktest,
  simulationRunDtoSchema,
  type BacktestDatasetReport,
  type SimulationRunDto,
} from '@aviator/shared';
import { HEALTH_OK, renderAt } from './renderApp';

// SYNTHETIC TEST FIXTURES: runs computed by the real engine from invented rounds.

const SOURCE = 'synthetic-ui';
const at = (s: number) => new Date(Date.UTC(2026, 0, 1, 0, 0, s)).toISOString();

function report(overrides: Partial<BacktestDatasetReport> = {}): BacktestDatasetReport {
  return {
    dataset: { source: SOURCE, importId: null, eventFrom: null, eventTo: null },
    roundsMatching: 4,
    roundsEligible: 3,
    excludedNoEventTime: 1,
    excludedSynthetic: 2,
    duplicateEventTimes: 0,
    nonCanonicalEventTimes: 0,
    firstEventAt: at(0),
    lastEventAt: at(2),
    orderable: true,
    problem: null,
    orderingRule: ORDERING_RULE,
    maxRounds: 100_000,
    ...overrides,
  };
}

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
  startingBankrollMinor: 1_000,
  insufficientBankrollPolicy: 'skip_leg' as const,
  risk: {
    stopBelowBankrollMinor: null,
    stopAtOrAboveBankrollMinor: null,
    maxDrawdownBps: null,
    maxRounds: null,
  },
};
const ROUNDS = [150, 200, 700].map((m, i) => ({
  roundId: i + 1,
  multiplierX100: m,
  eventAt: at(i),
}));
const RESULT = runBacktest(ROUNDS, STRATEGY, SETTINGS);

function completedRun(id: number, overrides: Partial<SimulationRunDto> = {}): SimulationRunDto {
  return simulationRunDtoSchema.parse({
    id,
    status: 'completed',
    createdAt: '2026-02-01T00:00:00.000Z',
    completedAt: '2026-02-01T00:00:01.000Z',
    errorMessage: null,
    strategy: STRATEGY,
    settings: SETTINGS,
    datasetRequest: report().dataset,
    dataset: report(),
    datasetSha256: 'ab'.repeat(32),
    summary: RESULT.summary,
    ...overrides,
  });
}

const FAILED_RUN = simulationRunDtoSchema.parse({
  ...completedRun(9),
  status: 'failed',
  completedAt: null,
  errorMessage: 'The backtest could not be completed. The transaction was rolled back.',
  dataset: null,
  datasetSha256: null,
  summary: null,
});

const LEDGER = {
  runId: 7,
  currency: 'NGN',
  rounds: RESULT.rounds.map((r) => ({ ...r })),
  totalRounds: 3,
  limit: 50,
  offset: 0,
};

const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status });
const apiError = (status: number, code: string, message: string, details?: unknown) =>
  json({ error: { code, message, ...(details === undefined ? {} : { details }) } }, status);

type Handler = (url: URL, init?: RequestInit) => Response | Promise<Response>;

function stub(routes: Record<string, Handler>, sources = [{ source: SOURCE, rounds: 4 }]) {
  const calls: { url: URL; init?: RequestInit | undefined }[] = [];
  vi.stubGlobal(
    'fetch',
    vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = new URL(typeof input === 'string' ? input : input.toString(), 'http://localhost');
      calls.push({ url, init });
      const key = `${init?.method ?? 'GET'} ${url.pathname}`;
      if (routes[key]) return routes[key](url, init);
      if (url.pathname === '/api/health') return json(HEALTH_OK);
      if (url.pathname === '/api/rounds/sources') return json({ items: sources });
      return apiError(404, 'not_found', 'nope');
    }),
  );
  return calls;
}

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

async function fillDataset() {
  const select = await screen.findByLabelText(/^Source/);
  await screen.findByRole('option', { name: `${SOURCE} (4)` });
  fireEvent.change(select, { target: { value: SOURCE } });
}

describe('Strategy lab', () => {
  it('pre-fills editable placeholder legs (2.00x and 6.00x) labelled as not recommended', async () => {
    stub({});
    renderAt('/strategy-lab');
    expect(
      screen.getByText(/editable placeholders, not recommended stakes or targets/),
    ).toBeTruthy();
    expect(
      (screen.getByLabelText(/^Cashout target/, { selector: '#legA-target' }) as HTMLInputElement)
        .value,
    ).toBe('2.00');
    expect(
      (screen.getByLabelText(/^Cashout target/, { selector: '#legB-target' }) as HTMLInputElement)
        .value,
    ).toBe('6.00');
    expect(screen.getByText(/does not predict future multipliers/)).toBeTruthy();
  });

  it('requires the assumptions to be acknowledged before running', async () => {
    stub({});
    renderAt('/strategy-lab');
    const run = screen.getByRole('button', { name: 'Run backtest' }) as HTMLButtonElement;
    expect(run.disabled).toBe(true);
    fireEvent.click(screen.getByLabelText(/I understand this replays recorded rounds/));
    expect(run.disabled).toBe(false);
  });

  it('shows field-level validation errors without calling the API', async () => {
    const calls = stub({});
    renderAt('/strategy-lab');
    fireEvent.change(screen.getByLabelText(/^Stake/, { selector: '#legA-stake' }), {
      target: { value: '5.555' },
    });
    fireEvent.change(screen.getByLabelText(/^Cashout target/, { selector: '#legB-target' }), {
      target: { value: '1.00' },
    });
    fireEvent.change(screen.getByLabelText(/^Starting bankroll/), { target: { value: '' } });
    fireEvent.click(screen.getByLabelText(/I understand/));
    fireEvent.click(screen.getByRole('button', { name: 'Run backtest' }));
    expect(await screen.findByText('Fix the highlighted fields before running.')).toBeTruthy();
    expect(
      screen.getByText(/at most two decimals\)\.$/, { selector: '#legA-stake-error' }),
    ).toBeTruthy();
    expect(screen.getByText('A cashout target must be at least 1.01x.')).toBeTruthy();
    expect(screen.getByText('Choose a source.')).toBeTruthy();
    expect(
      screen.getByLabelText(/^Stake/, { selector: '#legA-stake' }).getAttribute('aria-invalid'),
    ).toBe('true');
    expect(calls.some((c) => c.url.pathname === '/api/simulations')).toBe(false);
  });

  it('requires at least one enabled leg', async () => {
    stub({});
    renderAt('/strategy-lab');
    for (const box of screen.getAllByLabelText('Enabled')) fireEvent.click(box);
    fireEvent.click(screen.getByLabelText(/I understand/));
    fireEvent.click(screen.getByRole('button', { name: 'Run backtest' }));
    expect(await screen.findByText('Enable at least one leg.')).toBeTruthy();
  });

  it('checks the dataset and shows counts, exclusions and the ordering rule', async () => {
    const calls = stub({ 'GET /api/simulations/dataset': () => json(report()) });
    renderAt('/strategy-lab');
    await fillDataset();
    fireEvent.change(screen.getByLabelText(/^Event time from/), {
      target: { value: '2026-01-01T00:00:00Z' },
    });
    fireEvent.click(screen.getByRole('button', { name: 'Check dataset' }));
    expect(await screen.findByText('3 round(s) can be replayed in order.')).toBeTruthy();
    expect(screen.getByText(ORDERING_RULE)).toBeTruthy();
    expect(screen.getByText('Excluded: synthetic test fixtures').nextSibling?.textContent).toBe(
      '2',
    );
    const call = calls.find((c) => c.url.pathname === '/api/simulations/dataset')!;
    expect(Object.fromEntries(call.url.searchParams)).toEqual({
      source: SOURCE,
      eventFrom: '2026-01-01T00:00:00Z',
    });
  });

  it('explains why a dataset cannot be replayed', async () => {
    stub({
      'GET /api/simulations/dataset': () =>
        json(report({ orderable: false, duplicateEventTimes: 2, problem: 'Order is ambiguous.' })),
    });
    renderAt('/strategy-lab');
    await fillDataset();
    fireEvent.click(screen.getByRole('button', { name: 'Check dataset' }));
    expect(await screen.findByText('Cannot be replayed: Order is ambiguous.')).toBeTruthy();
  });

  it('notes when no rounds are stored', async () => {
    stub({}, []);
    renderAt('/strategy-lab');
    expect(await screen.findByText(/No rounds are stored yet/)).toBeTruthy();
  });

  it('sends exact integer amounts and opens the stored run', async () => {
    let posted: unknown;
    stub({
      'POST /api/simulations': (_url, init) => {
        posted = JSON.parse(String(init?.body));
        return json(completedRun(7), 201);
      },
      'GET /api/simulations/7': () => json(completedRun(7)),
      'GET /api/simulations/7/ledger': () => json(LEDGER),
    });
    renderAt('/strategy-lab');
    await fillDataset();
    fireEvent.change(screen.getByLabelText(/^Stake/, { selector: '#legA-stake' }), {
      target: { value: '1,250.5' },
    });
    fireEvent.change(screen.getByLabelText(/^Maximum rounds/), { target: { value: '50' } });
    fireEvent.change(screen.getByLabelText(/^Stop at drawdown/), { target: { value: '25.5' } });
    fireEvent.click(screen.getByLabelText(/I understand/));
    fireEvent.click(screen.getByRole('button', { name: 'Run backtest' }));
    expect(await screen.findByRole('heading', { name: 'Simulation run #7' })).toBeTruthy();
    expect(posted).toEqual({
      strategy: {
        schemaVersion: 1,
        currency: 'NGN',
        legs: {
          A: { label: 'Leg A', enabled: true, stakeMinor: 125_050, cashoutTargetX100: 200 },
          B: { label: 'Leg B', enabled: true, stakeMinor: 50_000, cashoutTargetX100: 600 },
        },
      },
      settings: {
        schemaVersion: 1,
        currency: 'NGN',
        startingBankrollMinor: 1_000_000,
        insufficientBankrollPolicy: 'skip_leg',
        risk: {
          stopBelowBankrollMinor: null,
          stopAtOrAboveBankrollMinor: null,
          maxDrawdownBps: 2_550,
          maxRounds: 50,
        },
      },
      dataset: { source: SOURCE, importId: null, eventFrom: null, eventTo: null },
    });
  });

  it('shows a running state, then server rejections and field errors', async () => {
    let release: (r: Response) => void = () => {};
    stub({
      'POST /api/simulations': () => new Promise<Response>((resolve) => (release = resolve)),
    });
    renderAt('/strategy-lab');
    await fillDataset();
    fireEvent.click(screen.getByLabelText(/I understand/));
    fireEvent.click(screen.getByRole('button', { name: 'Run backtest' }));
    expect(
      (screen.getByRole('button', { name: 'Running backtest…' }) as HTMLButtonElement).disabled,
    ).toBe(true);
    await act(async () =>
      release(
        apiError(400, 'validation_error', 'Request validation failed', [
          { path: 'dataset.eventFrom', message: 'must be an ISO-8601 date-time' },
        ]),
      ),
    );
    expect(await screen.findByText('Request validation failed')).toBeTruthy();
    expect(screen.getByText('must be an ISO-8601 date-time')).toBeTruthy();
    expect(
      (screen.getByRole('button', { name: 'Run backtest' }) as HTMLButtonElement).disabled,
    ).toBe(false);
  });
});

describe('Simulations list', () => {
  it('shows an honest empty state', async () => {
    stub({ 'GET /api/simulations': () => json({ items: [], total: 0, limit: 20, offset: 0 }) });
    renderAt('/simulations');
    expect(await screen.findByText('No simulations run yet')).toBeTruthy();
    expect(screen.getByText(/No example results are shown/)).toBeTruthy();
  });

  it('shows an error when the API fails', async () => {
    stub({
      'GET /api/simulations': () => apiError(500, 'internal_error', 'An unexpected error occurred'),
    });
    renderAt('/simulations');
    expect(await screen.findByText('An unexpected error occurred')).toBeTruthy();
  });

  it('lists completed and failed runs and compares selected runs', async () => {
    const other = completedRun(8, {
      datasetRequest: { ...report().dataset, source: 'synthetic-other' },
    });
    stub({
      'GET /api/simulations': () =>
        json({ items: [FAILED_RUN, other, completedRun(7)], total: 3, limit: 20, offset: 0 }),
    });
    renderAt('/simulations');
    const table = await screen.findByRole('table', { name: 'Simulation runs' });
    expect(within(table).getByText('Failed')).toBeTruthy();
    expect(within(table).getAllByText('Completed')).toHaveLength(2);
    expect(within(table).getAllByText('+₦4.00')).toHaveLength(2);
    expect(screen.queryByLabelText('Compare run #9')).toBeNull(); // failed runs have no results
    fireEvent.click(screen.getByLabelText('Compare run #7'));
    expect(screen.queryByRole('table', { name: /Comparison/ })).toBeNull();
    fireEvent.click(screen.getByLabelText('Compare run #8'));
    const comparison = screen.getByRole('table', {
      name: 'Comparison of selected simulation runs',
    });
    const row = within(comparison)
      .getByRole('rowheader', { name: 'Net (returned − staked)' })
      .closest('tr')!;
    expect(
      within(row)
        .getAllByRole('cell')
        .map((c) => c.textContent),
    ).toEqual(['+₦4.00', '+₦4.00']);
    expect(within(comparison).getByText(/synthetic-other/)).toBeTruthy();
    // Drawdown is reported as two separately defined metrics, never one mixed figure.
    const ddPct = within(comparison)
      .getByRole('rowheader', { name: 'Max drawdown (% of running peak)' })
      .closest('tr')!;
    const pct = `${(RESULT.summary.maxDrawdownFraction * 100).toFixed(1)}%`;
    expect(
      within(ddPct)
        .getAllByRole('cell')
        .map((c) => c.textContent),
    ).toEqual([pct, pct]);
    expect(
      within(comparison).getByRole('rowheader', { name: 'Max drawdown (amount)' }),
    ).toBeTruthy();
  });
});

describe('Simulation run detail', () => {
  it('shows the summary with denominators, per-leg results, ledger and reproducibility', async () => {
    stub({
      'GET /api/simulations/7': () => json(completedRun(7)),
      'GET /api/simulations/7/ledger': () => json(LEDGER),
    });
    renderAt('/simulations/7');
    expect(await screen.findByText('₦14.00')).toBeTruthy(); // ending bankroll 1400 minor
    expect(screen.getByText('+40.00% of the starting bankroll')).toBeTruthy();
    expect(screen.getByText(/1 of 3 replayed · 1 loss · 1 break-even/)).toBeTruthy();
    expect(screen.getByText('Every eligible round was replayed.', { exact: false })).toBeTruthy();

    const legs = screen.getByRole('table', { name: 'Results per leg' });
    const legA = within(legs)
      .getByRole('rowheader', { name: /A · Leg A/ })
      .closest('tr')!;
    expect(within(legA).getByText('66.7% of 3')).toBeTruthy();

    const ledger = await screen.findByRole('table', { name: 'Virtual ledger' });
    const rows = within(ledger).getAllByRole('row').slice(1);
    expect(rows).toHaveLength(3);
    expect(within(rows[2]!).getByText('7.00x')).toBeTruthy();
    expect(within(rows[2]!).getByText('+₦6.00')).toBeTruthy();

    expect(screen.getByText('ab'.repeat(32))).toBeTruthy();
    expect(screen.getByText(/Risk of ruin is not estimated/)).toBeTruthy();
    expect(screen.getByText('₦1.00 at 2.00x (“Leg A”)')).toBeTruthy();
    expect(screen.getByText(/largest relative fall 20\.0%/)).toBeTruthy();
    expect(screen.getByText('Invalid or non-canonical event times').nextSibling?.textContent).toBe(
      '0',
    );
  });

  it('shows a failed run without results', async () => {
    stub({ 'GET /api/simulations/9': () => json(FAILED_RUN) });
    renderAt('/simulations/9');
    expect(await screen.findByText(/This run failed and has no results or ledger/)).toBeTruthy();
    expect(screen.queryByRole('table', { name: 'Virtual ledger' })).toBeNull();
  });

  it('shows not-found errors', async () => {
    stub({
      'GET /api/simulations/404': () =>
        apiError(404, 'simulation_not_found', 'No such simulation run.'),
    });
    renderAt('/simulations/404');
    expect(await screen.findByText('No such simulation run.')).toBeTruthy();
    cleanup();
    renderAt('/simulations/abc');
    expect(await screen.findByText('No such simulation run.')).toBeTruthy();
  });
});
