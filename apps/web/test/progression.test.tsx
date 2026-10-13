import { cleanup, fireEvent, screen, within } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  ORDERING_RULE,
  runBacktest,
  simulationRunDtoSchema,
  type BacktestDatasetReport,
  type SimulationRunDto,
  type StakingPlan,
} from '@aviator/shared';
import { HEALTH_OK, renderAt } from './renderApp';

// SYNTHETIC TEST FIXTURES: runs computed by the real engine from invented rounds. Virtual
// money only; the progressions are arithmetic examples, not recommendations.

const SOURCE = 'synthetic-progression-ui';
const at = (s: number) => new Date(Date.UTC(2026, 0, 1, 0, 0, s)).toISOString();

const REPORT: BacktestDatasetReport = {
  dataset: { source: SOURCE, importId: null, eventFrom: null, eventTo: null },
  roundsMatching: 6,
  roundsEligible: 6,
  excludedNoEventTime: 0,
  excludedSynthetic: 0,
  duplicateEventTimes: 0,
  nonCanonicalEventTimes: 0,
  firstEventAt: at(0),
  lastEventAt: at(5),
  orderable: true,
  problem: null,
  orderingRule: ORDERING_RULE,
  maxRounds: 100_000,
};

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
  startingBankrollMinor: 550,
  insufficientBankrollPolicy: 'skip_leg' as const,
  risk: {
    stopBelowBankrollMinor: null,
    stopAtOrAboveBankrollMinor: null,
    maxDrawdownBps: null,
    maxRounds: null,
  },
};
// Leg A: flat ₦1.00 stakes. Leg B: Martingale ×3 allowing two steps (₦1.00, then ₦3.00).
// Round 2: after A is funded, ₦1.50 is left, so B's ₦3.00 is skipped (not a loss); A's win
// lets B stake ₦3.00 in round 3. B's second consecutive loss (round 5) reaches its step limit,
// so from round 6 B is stopped for good while A continues.
const PLAN: StakingPlan = {
  schemaVersion: 1,
  legs: {
    A: null,
    B: {
      schemaVersion: 1,
      currency: 'NGN',
      winResetPolicy: 'reset_to_base',
      mode: 'martingale',
      baseStakeMinor: 100,
      multiplierX100: 300,
      limits: { maxSteps: 2, maxStakeMinor: null, maxCycleExposureMinor: 10_000 },
    },
  },
};
const ROUNDS = [150, 200, 700, 150, 150, 700].map((m, i) => ({
  roundId: i + 1,
  multiplierX100: m,
  eventAt: at(i),
}));
const RESULT = runBacktest(ROUNDS, STRATEGY, SETTINGS, PLAN);

function run(id: number, overrides: Record<string, unknown> = {}): SimulationRunDto {
  return simulationRunDtoSchema.parse({
    id,
    status: 'completed',
    createdAt: '2026-02-01T00:00:00.000Z',
    completedAt: '2026-02-01T00:00:01.000Z',
    errorMessage: null,
    strategy: STRATEGY,
    settings: SETTINGS,
    datasetRequest: REPORT.dataset,
    dataset: REPORT,
    datasetSha256: 'cd'.repeat(32),
    summary: RESULT.summary,
    staking: PLAN,
    ...overrides,
  });
}

const LEDGER = {
  runId: 7,
  currency: 'NGN',
  rounds: RESULT.rounds,
  totalRounds: 6,
  limit: 50,
  offset: 0,
};

const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status });
const apiError = (status: number, code: string, message: string, details?: unknown) =>
  json({ error: { code, message, ...(details === undefined ? {} : { details }) } }, status);

type Handler = (url: URL, init?: RequestInit) => Response | Promise<Response>;

function stub(routes: Record<string, Handler>) {
  vi.stubGlobal(
    'fetch',
    vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = new URL(typeof input === 'string' ? input : input.toString(), 'http://localhost');
      const key = `${init?.method ?? 'GET'} ${url.pathname}`;
      if (routes[key]) return routes[key](url, init);
      if (url.pathname === '/api/health') return json(HEALTH_OK);
      if (url.pathname === '/api/rounds/sources') {
        return json({ items: [{ source: SOURCE, rounds: 6 }] });
      }
      return apiError(404, 'not_found', 'nope');
    }),
  );
}

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

async function fillDataset() {
  const select = await screen.findByLabelText(/^Source/);
  await screen.findByRole('option', { name: `${SOURCE} (6)` });
  fireEvent.change(select, { target: { value: SOURCE } });
}
const field = (id: string) => document.getElementById(id) as HTMLInputElement;
const setMode = (leg: 'A' | 'B', mode: string) =>
  fireEvent.change(field(`leg${leg}-mode`), { target: { value: mode } });
const type = (id: string, value: string) => fireEvent.change(field(id), { target: { value } });
const submit = () => {
  fireEvent.click(screen.getByLabelText(/I understand/));
  fireEvent.click(screen.getByRole('button', { name: 'Run backtest' }));
};

describe('Strategy lab staking', () => {
  it('defaults every leg to flat stakes and sends no staking plan', async () => {
    let posted: Record<string, unknown> | undefined;
    stub({
      'POST /api/simulations': (_url, init) => {
        posted = JSON.parse(String(init?.body)) as Record<string, unknown>;
        return json(
          run(7, { staking: null, summary: runBacktest(ROUNDS, STRATEGY, SETTINGS).summary }),
          201,
        );
      },
      'GET /api/simulations/7': () => json(run(7, { staking: null })),
      'GET /api/simulations/7/ledger': () => json(LEDGER),
    });
    renderAt('/strategy-lab');
    expect(field('legA-mode').value).toBe('flat');
    expect(field('legB-mode').value).toBe('flat');
    expect(screen.queryByLabelText(/^Multiplier after a loss/)).toBeNull();
    await fillDataset();
    submit();
    expect(await screen.findByRole('heading', { name: 'Simulation run #7' })).toBeTruthy();
    expect(posted).toBeDefined();
    expect('staking' in posted!).toBe(false);
  });

  it('shows the fields each mode needs, with the independence and no-edge caution', async () => {
    stub({});
    renderAt('/strategy-lab');
    setMode('A', 'martingale');
    expect(field('legA-multiplier').value).toBe('2.00');
    expect(field('legA-maxSteps')).toBeTruthy();
    expect(field('legA-sequence')).toBeNull();
    expect(screen.getByText(/Each leg progresses independently/)).toBeTruthy();
    expect(screen.getByText(/does not predict rounds or create an edge/)).toBeTruthy();
    expect(screen.getByText(/a skip is not a loss/)).toBeTruthy();
    setMode('A', 'custom');
    expect(field('legA-sequence')).toBeTruthy();
    expect(field('legA-multiplier')).toBeNull();
    expect(field('legA-maxSteps')).toBeNull();
    setMode('A', 'fixed');
    expect(field('legA-multiplier')).toBeNull();
    expect(field('legA-maxSteps')).toBeTruthy();
    setMode('A', 'flat');
    expect(screen.queryByText(/Each leg progresses independently/)).toBeNull();
  });

  it('validates progression fields without calling the API', async () => {
    const post = vi.fn(() => json({}, 500));
    stub({ 'POST /api/simulations': post });
    renderAt('/strategy-lab');
    await fillDataset();
    setMode('A', 'martingale');
    type('legA-multiplier', '11');
    type('legA-maxSteps', '0');
    setMode('B', 'custom');
    type('legB-sequence', '600, 1200');
    submit();
    expect(await screen.findByText('Fix the highlighted fields before running.')).toBeTruthy();
    expect(screen.getByText(/Enter a multiplier from 1.01 to 10/)).toBeTruthy();
    expect(screen.getByText(/Enter a whole number from 1 to 1000/)).toBeTruthy();
    expect(screen.getByText('Required for this mode.')).toBeTruthy(); // Martingale exposure cap
    expect(screen.getByText("The sequence must start with the leg's stake.")).toBeTruthy();
    expect(field('legA-maxExposure').getAttribute('aria-invalid')).toBe('true');
    expect(post).not.toHaveBeenCalled();
  });

  it('refuses a progression on a disabled leg and a configuration the engine rejects', async () => {
    const post = vi.fn(() => json({}, 500));
    stub({ 'POST /api/simulations': post });
    renderAt('/strategy-lab');
    await fillDataset();
    const legB = field('legB-mode').closest('section')!;
    expect(within(legB).getByRole('heading', { name: 'Leg B' })).toBeTruthy();
    fireEvent.click(within(legB).getByLabelText('Enabled'));
    setMode('B', 'fixed');
    type('legB-maxSteps', '3');
    setMode('A', 'capped_martingale');
    type('legA-maxSteps', '3');
    type('legA-maxStake', '100'); // below the leg's ₦500 stake: blocked from the start
    submit();
    expect(await screen.findByText('Enable the leg or set it back to flat stakes.')).toBeTruthy();
    expect(screen.getByText(/already blocked by the configuration/)).toBeTruthy();
    expect(post).not.toHaveBeenCalled();
  });

  it('sends each leg its own progression, based on the leg stake, in exact minor units', async () => {
    let posted: Record<string, unknown> | undefined;
    stub({
      'POST /api/simulations': (_url, init) => {
        posted = JSON.parse(String(init?.body)) as Record<string, unknown>;
        return json(run(7), 201);
      },
      'GET /api/simulations/7': () => json(run(7)),
      'GET /api/simulations/7/ledger': () => json(LEDGER),
    });
    renderAt('/strategy-lab');
    await fillDataset();
    setMode('A', 'martingale');
    type('legA-maxSteps', '4');
    type('legA-maxExposure', '7,500.50');
    setMode('B', 'custom');
    type('legB-sequence', '500, 750.25, 1000');
    type('legB-maxStake', '2000');
    submit();
    expect(await screen.findByRole('heading', { name: 'Simulation run #7' })).toBeTruthy();
    expect(posted?.staking).toEqual({
      schemaVersion: 1,
      legs: {
        A: {
          schemaVersion: 1,
          currency: 'NGN',
          winResetPolicy: 'reset_to_base',
          mode: 'martingale',
          baseStakeMinor: 50_000,
          multiplierX100: 200,
          limits: { maxSteps: 4, maxStakeMinor: null, maxCycleExposureMinor: 750_050 },
        },
        B: {
          schemaVersion: 1,
          currency: 'NGN',
          winResetPolicy: 'reset_to_base',
          mode: 'custom',
          stakesMinor: [50_000, 75_025, 100_000],
          afterFinalStep: 'stop',
          limits: { maxStakeMinor: 200_000, maxCycleExposureMinor: null },
        },
      },
    });
  });

  it('maps server staking errors onto the leg fields', async () => {
    stub({
      'POST /api/simulations': () =>
        apiError(400, 'validation_error', 'Request validation failed', [
          { path: 'staking.legs.A.limits.maxCycleExposureMinor', message: 'too large' },
          { path: 'staking.legs.A', message: "Leg A's progression must start at the leg's stake" },
        ]),
    });
    renderAt('/strategy-lab');
    await fillDataset();
    setMode('A', 'martingale');
    type('legA-maxSteps', '2');
    type('legA-maxExposure', '5000');
    submit();
    expect(await screen.findByText('too large')).toBeTruthy();
    expect(field('legA-maxExposure').getAttribute('aria-invalid')).toBe('true');
    expect(screen.getByText("Leg A's progression must start at the leg's stake")).toBeTruthy();
    expect(field('legA-mode').getAttribute('aria-invalid')).toBe('true');
  });
});

describe('Simulation run detail with a progression', () => {
  it('shows the plan, per-leg progression summary and auditable ledger steps', async () => {
    stub({
      'GET /api/simulations/7': () => json(run(7)),
      'GET /api/simulations/7/ledger': () => json(LEDGER),
    });
    renderAt('/simulations/7');
    expect(await screen.findByRole('heading', { name: 'Staking progression' })).toBeTruthy();
    expect(screen.getAllByText(/Each leg progresses independently/).length).toBeGreaterThan(0);
    const dd = (label: string, index = 0) =>
      screen.getAllByText(label)[index]!.nextSibling?.textContent;
    // Configuration as stored.
    expect(dd('Leg A staking')).toBe('Flat (same stake every round)');
    expect(dd('Leg B staking')).toBe(
      'Martingale ×3.00 · base ₦1.00 · up to 2 step(s) · max cycle exposure ₦100.00',
    );
    // Summary: B skipped once for lack of funds, then stopped by its step limit from round 6.
    expect(screen.getByText(/Flat stakes \(no progression\)/)).toBeTruthy();
    expect(dd('Final state')).toBe('Stopped by a limit: step limit reached; leg stopped');
    expect(dd('Stopped from round')).toBe('#6');
    expect(dd('Highest step placed')).toBe('1');
    expect(dd('Open cycle loss at the end')).toBe('₦4.00');
    expect(dd('Cycles completed (won)')).toBe('1');
    expect(dd('Skipped: bankroll could not fund')).toBe('1');
    expect(dd('Skipped: leg stopped by a limit')).toBe('1');
    expect(dd('Configuration key')).toMatch(/^fnv1a64:[0-9a-f]{16}$/);
    // Both analyses are offered, with how progressions are restarted.
    expect(screen.getByRole('link', { name: 'Open uncertainty analysis' })).toBeTruthy();
    expect(screen.getByRole('link', { name: 'Open robustness analysis' })).toBeTruthy();
    expect(
      screen.getByText(
        /Staking progressions restart from their first step on every resampled path/,
      ),
    ).toBeTruthy();

    const ledger = await screen.findByRole('table', { name: 'Virtual ledger' });
    const rows = within(ledger).getAllByRole('row').slice(1);
    expect(rows).toHaveLength(6);
    const legText = (row: number, leg: 'A' | 'B') =>
      within(rows[row]!).getByText(new RegExp(`^${leg} \\d`)).textContent;
    // The flat leg carries no progression detail.
    expect(legText(1, 'A')).not.toContain('step');
    // The requested stake is shown as requested, never as staked.
    const skipped = legText(1, 'B');
    expect(skipped).toContain('Skipped');
    expect(skipped).toContain('step 1 · requested ₦3.00');
    expect(skipped).toContain('the bankroll could not fund the requested stake (not a loss)');
    expect(skipped).not.toContain('staked');
    expect(skipped).toContain('cycle loss ₦1.00 → ₦1.00');
    expect(legText(2, 'B')).toContain(
      'staked ₦3.00 · returned ₦18.00 · step 1 · cycle loss ₦1.00 → ₦0.00',
    );
    expect(legText(5, 'B')).toContain('Skipped · step 2 · step limit reached; leg stopped');
    expect(legText(5, 'B')).not.toContain('requested');
  });

  it('shows older runs stored without a staking plan as flat stakes, with analyses offered', async () => {
    const flat = runBacktest(ROUNDS, STRATEGY, SETTINGS);
    const legacy: Record<string, unknown> = { ...run(8, { staking: null, summary: flat.summary }) };
    delete legacy.staking; // as an API response from before staking existed
    stub({
      'GET /api/simulations/8': () => json(legacy),
      'GET /api/simulations/8/ledger': () => json({ ...LEDGER, runId: 8, rounds: flat.rounds }),
    });
    renderAt('/simulations/8');
    expect(await screen.findByRole('link', { name: 'Open uncertainty analysis' })).toBeTruthy();
    expect(screen.queryByRole('heading', { name: 'Staking progression' })).toBeNull();
    expect(screen.getAllByText('Flat (same stake every round)')).toHaveLength(2);
    const ledger = await screen.findByRole('table', { name: 'Virtual ledger' });
    expect(within(ledger).queryByText(/step \d/)).toBeNull();
  });
});
