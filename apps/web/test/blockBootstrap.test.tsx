import { act, cleanup, fireEvent, screen, within } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  blockAnalysisDtoSchema,
  defaultBlockLength,
  maxBlockLength,
  maxPathsForSample,
  MOVING_BLOCK_ALGORITHM_VERSION,
  ORDERING_RULE,
  runBacktest,
  runBlockBootstrap,
  runBootstrap,
  simulationAnalysisDtoSchema,
  simulationRunDtoSchema,
  type BlockAnalysisDto,
  type SimulationRunDto,
  type StakingPlan,
} from '@aviator/shared';
import { LONGEST_LOSING_STREAK_DEFINITION } from '../src/pages/simulations/BlockBootstrapAnalyses';
import { UNCERTAINTY_CAUTION } from '../src/pages/simulations/UncertaintyPage';
import { HEALTH_OK, renderAt } from './renderApp';

// SYNTHETIC TEST FIXTURES: runs and analyses computed by the real engines from invented rounds.
// Virtual money only; the progression is an arithmetic example, not a recommendation.

const at = (s: number) => new Date(Date.UTC(2026, 0, 1, 0, 0, s)).toISOString();
const PATTERN = [150, 120, 700, 110, 990, 130, 120, 340, 101, 110, 205, 100];
const multipliers = (n: number) => Array.from({ length: n }, (_, i) => PATTERN[i % 12]!);
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

// Leg A: Martingale allowed six steps, longer than the default block length of 4.
const LONG_PLAN: StakingPlan = {
  schemaVersion: 1,
  legs: {
    A: {
      ...PLAN.legs.A!,
      limits: { maxSteps: 6, maxStakeMinor: null, maxCycleExposureMinor: 100_000 },
    } as StakingPlan['legs']['A'],
    B: null,
  },
};

const SAMPLES = new Map<number, number[]>();

function makeRun(id: number, n = 60, staking: StakingPlan | null = null): SimulationRunDto {
  const sample = multipliers(n);
  SAMPLES.set(id, sample);
  const rounds = sample.map((m, i) => ({ roundId: i + 1, multiplierX100: m, eventAt: at(i) }));
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
      roundsMatching: n,
      roundsEligible: n,
      excludedNoEventTime: 0,
      excludedSynthetic: 0,
      duplicateEventTimes: 0,
      nonCanonicalEventTimes: 0,
      firstEventAt: at(0),
      lastEventAt: at(n - 1),
      orderable: true,
      problem: null,
      orderingRule: ORDERING_RULE,
      maxRounds: 100_000,
    },
    datasetSha256: 'ab'.repeat(32),
    summary: (staking === null
      ? runBacktest(rounds, STRATEGY, SETTINGS)
      : runBacktest(rounds, STRATEGY, SETTINGS, staking)
    ).summary,
    ...(staking === null ? {} : { staking }),
  });
}

function makeBlock(
  run: SimulationRunDto,
  id: number,
  { paths = 200, seed = 42, blockLength = 4 } = {},
): BlockAnalysisDto {
  const sample = SAMPLES.get(run.id)!;
  return blockAnalysisDtoSchema.parse({
    id,
    simulationRunId: run.id,
    status: 'completed',
    method: 'moving_block_bootstrap',
    createdAt: '2026-02-02T00:00:00.000Z',
    completedAt: '2026-02-02T00:00:01.000Z',
    algorithmVersion: MOVING_BLOCK_ALGORITHM_VERSION,
    seed,
    paths,
    blockLength,
    sampleSize: sample.length,
    datasetSha256: run.datasetSha256,
    summary: runBlockBootstrap(
      sample,
      run.strategy,
      run.settings,
      { paths, seed, blockLength },
      run.summary!,
      run.staking,
    ),
  });
}

/** The list response exactly as the server builds it for this sample size. */
function blockList(items: BlockAnalysisDto[], n: number, total = items.length) {
  const eligible = n >= 20;
  return {
    items,
    total,
    maxPaths: eligible ? maxPathsForSample(n) : 0,
    maxBlockLength: eligible ? maxBlockLength(n) : 0,
    defaultBlockLength: eligible ? defaultBlockLength(n) : null,
    sampleSize: n,
  };
}

const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status });
const notFound = () =>
  json(
    {
      error: {
        code: 'block_analysis_not_found',
        message: 'No such block bootstrap analysis for this run.',
      },
    },
    404,
  );

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
const requestsTo = (calls: { url: URL; init?: RequestInit | undefined }[], fragment: string) =>
  calls.filter((c) => c.url.pathname.includes(fragment));
const posts = (calls: { url: URL; init?: RequestInit | undefined }[]) =>
  calls.filter((c) => c.init?.method === 'POST');

const iidList = { items: [], total: 0, maxPaths: 2_000, sampleSize: 60 };

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

const blockForm = () => screen.findByRole('form', { name: 'Moving-block bootstrap settings' });
const blockLengthInput = () => screen.getByLabelText(/^Block length/) as HTMLInputElement;

describe('A. Method selection', () => {
  it('defaults to IID and never requests block analyses until chosen', async () => {
    const run = makeRun(7);
    const calls = stub({
      'GET /api/simulations/7': () => json(run),
      'GET /api/simulations/7/analyses': () => json(iidList),
    });
    renderAt('/simulations/7/uncertainty');
    expect(await screen.findByRole('form', { name: 'Uncertainty analysis settings' })).toBeTruthy();
    const iid = screen.getByRole('radio', { name: /IID bootstrap/ }) as HTMLInputElement;
    const block = screen.getByRole('radio', { name: /moving-block bootstrap/ }) as HTMLInputElement;
    expect(iid.checked).toBe(true);
    expect(block.checked).toBe(false);
    expect(screen.getByText(UNCERTAINTY_CAUTION)).toBeTruthy();
    expect(screen.queryByRole('form', { name: 'Moving-block bootstrap settings' })).toBeNull();
    expect(requestsTo(calls, 'block-analyses')).toHaveLength(0);
  });

  it('switches methods without carrying settings across, and IID posts only its own fields', async () => {
    const run = makeRun(7);
    const iidCreated = simulationAnalysisDtoSchema.parse({
      id: 1,
      simulationRunId: 7,
      status: 'completed',
      createdAt: '2026-02-02T00:00:00.000Z',
      completedAt: '2026-02-02T00:00:01.000Z',
      algorithmVersion: 'iid-bootstrap/xoshiro128ss-fmix32/v1',
      seed: 5,
      paths: 50,
      datasetSha256: run.datasetSha256,
      summary: runBootstrap(
        SAMPLES.get(7)!,
        run.strategy,
        run.settings,
        { paths: 50, seed: 5 },
        run.summary!,
      ),
    });
    const calls = stub({
      'GET /api/simulations/7': () => json(run),
      'GET /api/simulations/7/analyses': () => json(iidList),
      'GET /api/simulations/7/block-analyses': () => json(blockList([], 60)),
      'POST /api/simulations/7/analyses': () => json(iidCreated, 201),
    });
    renderAt('/simulations/7/uncertainty');
    fireEvent.click(await screen.findByRole('radio', { name: /moving-block bootstrap/ }));
    await blockForm();
    expect(screen.getByText(/conditional on the moving-block bootstrap model/)).toBeTruthy();
    expect(screen.queryByText(UNCERTAINTY_CAUTION)).toBeNull();
    expect(screen.getByRole('region', { name: 'Method' }).textContent).toMatch(
      /Moving-block bootstrap/,
    );
    fireEvent.change(blockLengthInput(), { target: { value: '5' } });
    fireEvent.change(screen.getByLabelText(/^Resampled paths/), { target: { value: '77' } });

    fireEvent.click(screen.getByRole('radio', { name: /IID bootstrap/ }));
    const iidForm = await screen.findByRole('form', { name: 'Uncertainty analysis settings' });
    expect(screen.queryByLabelText(/^Block length/)).toBeNull();
    // IID keeps its own defaults: nothing typed under the other method leaks across.
    expect((within(iidForm).getByLabelText(/^Resampled paths/) as HTMLInputElement).value).toBe(
      '500',
    );
    fireEvent.change(within(iidForm).getByLabelText(/^Resampled paths/), {
      target: { value: '50' },
    });
    fireEvent.change(within(iidForm).getByLabelText(/^Seed/), { target: { value: '5' } });
    fireEvent.click(screen.getByRole('button', { name: 'Run analysis' }));
    expect(await screen.findByText(/IID bootstrap · 50 paths × 60 draws · seed 5/)).toBeTruthy();
    const [post] = posts(calls);
    expect(post!.url.pathname).toBe('/api/simulations/7/analyses');
    expect(JSON.parse(String(post!.init!.body))).toEqual({ paths: 50, seed: 5 });
  });

  it('opens the block method directly from the URL and shows the method in results', async () => {
    const run = makeRun(7);
    stub({
      'GET /api/simulations/7': () => json(run),
      'GET /api/simulations/7/block-analyses': () => json(blockList([makeBlock(run, 3)], 60)),
    });
    renderAt('/simulations/7/uncertainty?method=moving-block');
    expect(await screen.findByText(/Moving-block results · analysis #3/)).toBeTruthy();
    expect(screen.getByText(/Moving-block bootstrap · block length 4 · 200 paths/)).toBeTruthy();
    expect(
      (screen.getByRole('radio', { name: /moving-block bootstrap/ }) as HTMLInputElement).checked,
    ).toBe(true);
  });

  it('describes both methods without claiming to predict outcomes', async () => {
    const run = makeRun(7);
    stub({
      'GET /api/simulations/7': () => json(run),
      'GET /api/simulations/7/block-analyses': () => json(blockList([], 60)),
    });
    renderAt('/simulations/7/uncertainty?method=moving-block');
    await blockForm();
    const method = screen.getByRole('region', { name: 'Method' }).textContent!;
    expect(method).toMatch(/order is kept within each block/);
    expect(method).toMatch(/may overlap, and the same block may be drawn more than once/);
    expect(method).toMatch(/never wrap from the end of the sample/);
    expect(method).toMatch(/can span a gap in the recording/);
    expect(method).toMatch(/conditional on this one sample, the block length/);
    expect(method).toMatch(/sensitivity check/);
    expect(method).toMatch(/does not predict future rounds/);
    expect(method).toMatch(/not a claim that rounds influence each other/);
    expect(method).toMatch(/Losing streaks longer than the block length can\s+only form by chance/);
    expect(method).toMatch(/does not show an edge or guarantee anything/);
    expect(method).not.toMatch(/staking progression/); // a flat run has no progression note
  });
});

describe('B. Block-length configuration and validation', () => {
  it('shows the sample size, default and limits from the list endpoint', async () => {
    const run = makeRun(7);
    stub({
      'GET /api/simulations/7': () => json(run),
      'GET /api/simulations/7/block-analyses': () => json(blockList([], 60)),
    });
    renderAt('/simulations/7/uncertainty?method=moving-block');
    await blockForm();
    expect(blockLengthInput().value).toBe('4'); // round(cbrt(60)) = 4
    const hint = document.getElementById('block-length-hint')!.textContent!;
    expect(hint).toMatch(/Default 4 for n = 60/);
    expect(hint).toMatch(/2 to 6 for this sample/);
    expect(hint).toMatch(/a common convention rather than the best choice for this data/);
    expect(screen.getByLabelText('Block length (rounds per block) *')).toBe(blockLengthInput());
    expect(screen.getByTestId('block-layout').textContent).toBe(
      'With b = 4: each path is 15 blocks of 4 rounds, each block starting at one of 57 possible positions. That is fewer than 100 possible starts, so paths will reuse the same stretches heavily and the result will carry a warning.',
    );
    fireEvent.change(blockLengthInput(), { target: { value: '6' } });
    expect(screen.getByTestId('block-layout').textContent).toMatch(
      /^With b = 6: each path is 10 blocks of 6 rounds, each block starting at one of 55/,
    );
    fireEvent.change(blockLengthInput(), { target: { value: '2' } });
    fireEvent.click(screen.getByRole('button', { name: 'Use default' }));
    expect(blockLengthInput().value).toBe('4');
  });

  it.each([['2.5'], ['1'], ['7'], ['0'], [''], ['abc'], ['-3'], ['4e0']])(
    'rejects %j locally without a request',
    async (value) => {
      const run = makeRun(7);
      const calls = stub({
        'GET /api/simulations/7': () => json(run),
        'GET /api/simulations/7/block-analyses': () => json(blockList([], 60)),
      });
      renderAt('/simulations/7/uncertainty?method=moving-block');
      await blockForm();
      fireEvent.change(blockLengthInput(), { target: { value } });
      expect(screen.getByTestId('block-layout').textContent).toBe(
        'Enter a valid block length to see how each path is built.',
      );
      fireEvent.click(screen.getByRole('button', { name: 'Run block analysis' }));
      expect(await screen.findByText('Enter a whole number from 2 to 6.')).toBeTruthy();
      expect(blockLengthInput().getAttribute('aria-invalid')).toBe('true');
      expect(posts(calls)).toHaveLength(0);
    },
  );

  it('uses the larger limits of a larger sample', async () => {
    const run = makeRun(8, 1_000);
    stub({
      'GET /api/simulations/8': () => json(run),
      'GET /api/simulations/8/block-analyses': () => json(blockList([], 1_000)),
    });
    renderAt('/simulations/8/uncertainty?method=moving-block');
    await blockForm();
    expect(blockLengthInput().value).toBe('10');
    expect(document.getElementById('block-length-hint')!.textContent).toMatch(/2 to 100/);
    expect(screen.getByTestId('block-layout').textContent).not.toMatch(/fewer than 100/);
    fireEvent.change(blockLengthInput(), { target: { value: '7' } });
    expect(screen.getByTestId('block-layout').textContent).toBe(
      'With b = 7: each path is 142 blocks of 7 rounds plus one of 6, each block starting at one of 994 possible positions.',
    );
  });

  it('explains a sample under 20 rounds and offers no form', async () => {
    const run = makeRun(9, 12);
    const calls = stub({
      'GET /api/simulations/9': () => json(run),
      'GET /api/simulations/9/block-analyses': () => json(blockList([], 12)),
    });
    renderAt('/simulations/9/uncertainty?method=moving-block');
    expect(
      await screen.findByText(/sample has 12 rounds\. A block bootstrap needs at least 20/),
    ).toBeTruthy();
    expect(screen.getByText(/at least 10 blocks of at least 2 rounds/)).toBeTruthy();
    expect(screen.queryByRole('form', { name: 'Moving-block bootstrap settings' })).toBeNull();
    expect(screen.getByText(/too small for a block bootstrap\. No example results/)).toBeTruthy();
    expect(posts(calls)).toHaveLength(0);
  });
});

describe('C. Submission', () => {
  it('posts paths, seed and block length once, shows progress, then the stored result', async () => {
    const run = makeRun(7);
    const created = makeBlock(run, 5, { paths: 120, seed: 99, blockLength: 3 });
    let release: (r: Response) => void = () => {};
    let analyses: BlockAnalysisDto[] = [];
    const calls = stub({
      'GET /api/simulations/7': () => json(run),
      'GET /api/simulations/7/block-analyses': () => json(blockList(analyses, 60)),
      'POST /api/simulations/7/block-analyses': () =>
        new Promise<Response>((resolve) => (release = resolve)),
    });
    renderAt('/simulations/7/uncertainty?method=moving-block');
    await blockForm();
    fireEvent.change(blockLengthInput(), { target: { value: '3' } });
    fireEvent.change(screen.getByLabelText(/^Resampled paths/), { target: { value: '120' } });
    fireEvent.change(screen.getByLabelText(/^Seed/), { target: { value: '99' } });
    const form = await blockForm();
    fireEvent.submit(form);
    fireEvent.submit(form); // a second submit while one is in flight is ignored
    const busy = screen.getByRole('button', { name: 'Resampling blocks…' }) as HTMLButtonElement;
    expect(busy.disabled).toBe(true);
    expect(form.getAttribute('aria-busy')).toBe('true');
    expect(posts(calls)).toHaveLength(1);
    expect(JSON.parse(String(posts(calls)[0]!.init!.body))).toEqual({
      paths: 120,
      seed: 99,
      blockLength: 3,
    });
    analyses = [created];
    await act(async () => release(json(created, 201)));
    expect(await screen.findByText(/Moving-block results · analysis #5/)).toBeTruthy();
    expect(posts(calls)).toHaveLength(1);
    expect(blockLengthInput().value).toBe('3');
  });

  it('shows a server rejection on the field, keeps the settings and does not retry', async () => {
    const run = makeRun(7);
    const calls = stub({
      'GET /api/simulations/7': () => json(run),
      'GET /api/simulations/7/block-analyses': () => json(blockList([], 60)),
      'POST /api/simulations/7/block-analyses': () =>
        json(
          {
            error: {
              code: 'block_length_too_large',
              message:
                "This run's sample has 60 rounds, so the block length can be at most 6 (at least 10 blocks per path).",
              details: { maxBlockLength: 6, sampleSize: 60 },
            },
          },
          422,
        ),
    });
    renderAt('/simulations/7/uncertainty?method=moving-block');
    await blockForm();
    fireEvent.change(blockLengthInput(), { target: { value: '5' } });
    fireEvent.change(screen.getByLabelText(/^Seed/), { target: { value: '31' } });
    fireEvent.click(screen.getByRole('button', { name: 'Run block analysis' }));
    expect(await screen.findByRole('alert')).toBeTruthy();
    expect(screen.getAllByText(/the block length can be at most 6/)).toHaveLength(2);
    expect(document.getElementById('block-length-error')!.textContent).toMatch(/at most 6/);
    expect(blockLengthInput().value).toBe('5');
    expect((screen.getByLabelText(/^Seed/) as HTMLInputElement).value).toBe('31');
    expect(screen.getByRole('button', { name: 'Run block analysis' })).toBeTruthy();
    expect(posts(calls)).toHaveLength(1);
    expect(screen.queryByText(/Moving-block results · analysis/)).toBeNull();
    expect(screen.getByText('No block analysis yet')).toBeTruthy();
  });

  it('shows other server errors as they are, with no invented result', async () => {
    const run = makeRun(7);
    stub({
      'GET /api/simulations/7': () => json(run),
      'GET /api/simulations/7/block-analyses': () => json(blockList([], 60)),
      'POST /api/simulations/7/block-analyses': () =>
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
    renderAt('/simulations/7/uncertainty?method=moving-block');
    fireEvent.click(await screen.findByRole('button', { name: 'Run block analysis' }));
    expect(await screen.findByText(/have changed since it ran/)).toBeTruthy();
    expect(screen.getByText('No block analysis yet')).toBeTruthy();
  });
});

describe('D. Results', () => {
  it('shows metadata, distributions including streaks, and outcome counts', async () => {
    const run = makeRun(7);
    const a = makeBlock(run, 3);
    stub({
      'GET /api/simulations/7': () => json(run),
      'GET /api/simulations/7/block-analyses': () => json(blockList([a], 60)),
    });
    renderAt('/simulations/7/uncertainty?method=moving-block');
    const details = await screen.findByRole('region', { name: 'Analysis details' });
    const value = (label: string) => within(details).getByText(label).nextSibling?.textContent;
    expect(value('Method')).toBe('Moving-block bootstrap (non-circular)');
    expect(value('Paths')).toBe('200');
    expect(value('Sample size (n)')).toBe('60 rounds');
    expect(value('Block length (b)')).toBe('4 rounds');
    expect(value('Blocks per path')).toBe('15: 15 blocks of 4 rounds');
    expect(value('Possible block starts (n − b + 1)')).toBe('57');
    expect(value('Seed')).toBe('42');
    expect(value('Algorithm version')).toBe(MOVING_BLOCK_ALGORITHM_VERSION);

    const table = screen.getByRole('table', {
      name: 'Observed value and distribution of resampled path values',
    });
    const rowCells = (name: string) =>
      within(within(table).getByRole('rowheader', { name }).closest('tr')!)
        .getAllByRole('cell')
        .map((c) => c.textContent);
    const s = a.summary;
    for (const name of [
      'Ending bankroll',
      'Max drawdown (% of running peak)',
      'Max drawdown (amount)',
      'Rounds replayed',
    ]) {
      expect(rowCells(name)).toHaveLength(8);
    }
    const streak = rowCells('Longest losing streak (rounds)');
    expect(streak).toEqual([
      String(run.summary!.longestLosingStreak),
      String(s.longestLosingStreak.min),
      ...s.longestLosingStreak.quantiles.map((q) => String(q.value)),
      String(s.longestLosingStreak.max),
    ]);
    expect(screen.getByText(LONGEST_LOSING_STREAK_DEFINITION)).toBeTruthy();
    expect(LONGEST_LOSING_STREAK_DEFINITION).toMatch(
      /negative combined net outcome across both legs; a break-even round ends the streak/,
    );

    const n = s.netOutcome;
    expect(screen.getByText('Ended below the start (net < 0)').nextSibling?.textContent).toBe(
      `${n.negative} of 200 (${((n.negative / 200) * 100).toFixed(1)}%)`,
    );
    const stops = screen.getByRole('table', { name: 'Paths by stop reason' });
    expect(within(stops).getAllByRole('row')).toHaveLength(8);
    expect(screen.getByText('Lower bankroll stop').nextSibling?.textContent).toBe(
      'Not configured for this run',
    );
    expect(screen.getByText(/not chances of making money in future rounds/)).toBeTruthy();
    expect(screen.getByText(/paths; not confidence intervals/)).toBeTruthy();
  });

  it('surfaces the few-candidate-blocks warning with a plain-language explanation', async () => {
    const run = makeRun(7);
    const a = makeBlock(run, 3);
    expect(a.summary.warnings.map((w) => w.code)).toContain('few_candidate_blocks');
    stub({
      'GET /api/simulations/7': () => json(run),
      'GET /api/simulations/7/block-analyses': () => json(blockList([a], 60)),
    });
    renderAt('/simulations/7/uncertainty?method=moving-block');
    await screen.findByText(/Moving-block results · analysis #3/);
    for (const w of a.summary.warnings) expect(screen.getByText(w.message)).toBeTruthy();
    expect(
      screen.getByText(
        /a block can start at only 57 positions \(n − b \+ 1 with b = 4\), fewer than 100/,
      ),
    ).toBeTruthy();
  });

  it('shows no few-candidate warning when there are enough starts', async () => {
    const run = makeRun(8, 1_000);
    const a = makeBlock(run, 4, { paths: 40, blockLength: 10 });
    expect(a.summary.warnings.map((w) => w.code)).not.toContain('few_candidate_blocks');
    stub({
      'GET /api/simulations/8': () => json(run),
      'GET /api/simulations/8/block-analyses': () => json(blockList([a], 1_000)),
    });
    renderAt('/simulations/8/uncertainty?method=moving-block');
    await screen.findByText(/Moving-block results · analysis #4/);
    expect(screen.queryByText(/What this means/)).toBeNull();
  });

  it('shows per-leg staking for a run with a progression', async () => {
    const run = makeRun(10, 60, PLAN);
    const a = makeBlock(run, 6);
    stub({
      'GET /api/simulations/10': () => json(run),
      'GET /api/simulations/10/block-analyses': () => json(blockList([a], 60)),
    });
    renderAt('/simulations/10/uncertainty?method=moving-block');
    const staking = await screen.findByRole('region', {
      name: 'Staking progressions on resampled paths',
    });
    const legA = a.summary.staking!.legs.A!;
    expect(
      within(staking).getByText('Leg A: paths where a limit stopped it').nextSibling?.textContent,
    ).toMatch(new RegExp(`^${legA.pathsStoppedByLimit} of 200 `));
    expect(within(staking).getByText('Leg B').nextSibling?.textContent).toBe('Flat stakes');
    expect(screen.getByRole('region', { name: 'Method' }).textContent).toMatch(
      /streaks inside a block are kept as recorded/,
    );
    const details = screen.getByRole('region', { name: 'Analysis details' });
    expect(
      within(details).getByText('Leg A: step limit beside block length').nextSibling?.textContent,
    ).toBe('2 steps · block length 4 rounds');
    expect(within(details).queryByText(/Leg B: step limit/)).toBeNull();
  });

  it('warns when the block length is shorter than a progression step limit', async () => {
    const run = makeRun(11, 60, LONG_PLAN);
    const a = makeBlock(run, 7);
    stub({
      'GET /api/simulations/11': () => json(run),
      'GET /api/simulations/11/block-analyses': () => json(blockList([a], 60)),
    });
    renderAt('/simulations/11/uncertainty?method=moving-block');
    const details = await screen.findByRole('region', { name: 'Analysis details' });
    expect(
      within(details).getByText('Leg A: step limit beside block length').nextSibling?.textContent,
    ).toBe(
      '6 steps · block length 4 rounds. A losing streak long enough to reach this limit cannot fit inside one block, so it can only form by chance across block joins.',
    );
    expect(screen.getByTestId('block-layout').textContent).toMatch(
      /This is shorter than a progression's step limit \(6\), so streaks reaching it can only form across block joins\./,
    );
    fireEvent.change(blockLengthInput(), { target: { value: '6' } });
    expect(screen.getByTestId('block-layout').textContent).not.toMatch(/step limit/);
    expect(screen.getByText('Resampled (block bootstrap, b = 4)')).toBeTruthy();
  });
});

describe('E. Saved block analyses', () => {
  it('lists saved analyses with their block lengths and switches between them without refetching', async () => {
    const run = makeRun(7);
    const newer = makeBlock(run, 9, { paths: 100, seed: 7, blockLength: 6 });
    const older = makeBlock(run, 4, { paths: 200, seed: 42, blockLength: 2 });
    const calls = stub({
      'GET /api/simulations/7': () => json(run),
      'GET /api/simulations/7/block-analyses': () => json(blockList([newer, older], 60)),
    });
    renderAt('/simulations/7/uncertainty?method=moving-block');
    expect(await screen.findByText(/Moving-block results · analysis #9/)).toBeTruthy();
    const table = screen.getByRole('table', { name: 'Saved moving-block bootstrap analyses' });
    const rows = within(table)
      .getAllByRole('row')
      .slice(1)
      .map((r) =>
        within(r)
          .getAllByRole('cell')
          .map((c) => c.textContent),
      );
    expect(rows.map((r) => [r[0], r[2], r[3], r[4]])).toEqual([
      ['#9', '6', '100', '7'],
      ['#4', '2', '200', '42'],
    ]);
    expect(screen.getByRole('button', { name: 'Showing' }).getAttribute('aria-pressed')).toBe(
      'true',
    );
    const before = calls.length;
    fireEvent.click(screen.getByRole('button', { name: 'Show block analysis #4' }));
    expect(await screen.findByText(/Moving-block results · analysis #4/)).toBeTruthy();
    expect(screen.queryByText(/Moving-block results · analysis #9/)).toBeNull();
    expect(calls.length).toBe(before); // shown from the loaded list, not recomputed or refetched
    expect(screen.getByText(/IID analyses are listed under the IID method/)).toBeTruthy();
  });

  it('reads a linked analysis outside the list once from the detail endpoint', async () => {
    const run = makeRun(7);
    const old = makeBlock(run, 2, { blockLength: 5 });
    const calls = stub({
      'GET /api/simulations/7': () => json(run),
      'GET /api/simulations/7/block-analyses': () => json(blockList([makeBlock(run, 60)], 60, 51)),
      'GET /api/simulations/7/block-analyses/2': () => json(old),
    });
    renderAt('/simulations/7/uncertainty?method=moving-block&analysis=2');
    expect(await screen.findByText(/Moving-block results · analysis #2/)).toBeTruthy();
    expect(screen.getByText(/showing the newest 1 of 51/)).toBeTruthy();
    expect(requestsTo(calls, '/block-analyses/2')).toHaveLength(1);
    expect(posts(calls)).toHaveLength(0);
  });

  it('reports a linked analysis that does not exist', async () => {
    const run = makeRun(7);
    stub({
      'GET /api/simulations/7': () => json(run),
      'GET /api/simulations/7/block-analyses': () => json(blockList([makeBlock(run, 3)], 60)),
      'GET /api/simulations/7/block-analyses/99': notFound,
    });
    renderAt('/simulations/7/uncertainty?method=moving-block&analysis=99');
    expect(await screen.findByText(/Block analysis #99 was not found for this run/)).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Show the newest block analysis' }));
    expect(await screen.findByText(/Moving-block results · analysis #3/)).toBeTruthy();
  });

  it('shows loading, empty and error states honestly', async () => {
    const run = makeRun(7);
    stub({
      'GET /api/simulations/7': () => json(run),
      'GET /api/simulations/7/block-analyses': () => new Promise<Response>(() => {}),
    });
    renderAt('/simulations/7/uncertainty?method=moving-block');
    expect(await screen.findByText('Loading block analyses…')).toBeTruthy();
    cleanup();

    stub({
      'GET /api/simulations/7': () => json(run),
      'GET /api/simulations/7/block-analyses': () => json(blockList([], 60)),
    });
    renderAt('/simulations/7/uncertainty?method=moving-block');
    expect(await screen.findByText('No block analysis yet')).toBeTruthy();
    expect(screen.getByText(/No example results are shown/)).toBeTruthy();
    expect(
      screen.queryByRole('table', { name: 'Saved moving-block bootstrap analyses' }),
    ).toBeNull();
    cleanup();

    stub({
      'GET /api/simulations/7': () => json(run),
      'GET /api/simulations/7/block-analyses': () =>
        json(
          {
            error: {
              code: 'stored_data_invalid',
              message: 'A stored block analysis failed validation.',
            },
          },
          500,
        ),
    });
    renderAt('/simulations/7/uncertainty?method=moving-block');
    expect(await screen.findByText('A stored block analysis failed validation.')).toBeTruthy();
    expect(screen.queryByText(/Moving-block results · analysis/)).toBeNull();
    expect(screen.queryByRole('form', { name: 'Moving-block bootstrap settings' })).toBeNull();
  });

  it('keeps IID and block lists separate', async () => {
    const run = makeRun(7);
    const calls = stub({
      'GET /api/simulations/7': () => json(run),
      'GET /api/simulations/7/analyses': () => json(iidList),
      'GET /api/simulations/7/block-analyses': () => json(blockList([makeBlock(run, 3)], 60)),
    });
    renderAt('/simulations/7/uncertainty');
    expect(await screen.findByText('No analysis yet')).toBeTruthy();
    expect(screen.queryByText(/Moving-block results/)).toBeNull();
    fireEvent.click(screen.getByRole('radio', { name: /moving-block bootstrap/ }));
    expect(await screen.findByText(/Moving-block results · analysis #3/)).toBeTruthy();
    expect(screen.queryByText('No analysis yet')).toBeNull();
    expect(requestsTo(calls, '/analyses').every((c) => !c.url.search.includes('method'))).toBe(
      true,
    );
  });
});

describe('G. Accessibility', () => {
  it('labels the selector and fields, links errors and announces changes', async () => {
    const run = makeRun(7);
    stub({
      'GET /api/simulations/7': () => json(run),
      'GET /api/simulations/7/analyses': () => json(iidList),
      'GET /api/simulations/7/block-analyses': () => json(blockList([], 60)),
    });
    renderAt('/simulations/7/uncertainty');
    const group = await screen.findByRole('group', { name: 'Resampling method' });
    const radios = within(group).getAllByRole('radio');
    expect(radios).toHaveLength(2);
    for (const r of radios) {
      const described = document.getElementById(r.getAttribute('aria-describedby')!);
      expect(described?.textContent).toBeTruthy();
    }
    fireEvent.click(radios[1]!);
    await blockForm();
    const input = blockLengthInput();
    expect(input.getAttribute('aria-describedby')).toBe('block-length-hint');
    fireEvent.change(input, { target: { value: '2.5' } });
    fireEvent.click(screen.getByRole('button', { name: 'Run block analysis' }));
    await screen.findByText('Enter a whole number from 2 to 6.');
    expect(input.getAttribute('aria-describedby')).toBe('block-length-hint block-length-error');
    expect(screen.getByTestId('block-layout').getAttribute('aria-live')).toBe('polite');
    expect(screen.getByLabelText(/^Resampled paths/).id).toBe('block-paths');
    expect(screen.getByLabelText(/^Seed/).id).toBe('block-seed');
  });
});
