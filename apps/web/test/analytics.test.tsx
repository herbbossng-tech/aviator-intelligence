import { act, cleanup, fireEvent, screen, within } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  ANALYTICS_METHOD,
  analyticsResponseSchema,
  computeAnalytics,
  type AnalyticsResponse,
  type MultiplierFrequency,
} from '@aviator/shared';
import { HEALTH_OK, renderAt } from './renderApp';

// SYNTHETIC TEST FIXTURES: analytics responses computed from invented frequency tables.

function response(
  frequencies: MultiplierFrequency[],
  dataset: Partial<AnalyticsResponse['dataset']> = {},
): AnalyticsResponse {
  const n = frequencies.reduce((s, f) => s + f.count, 0);
  return analyticsResponseSchema.parse({
    dataset: {
      filters: {
        source: null,
        importId: null,
        minMultiplierX100: null,
        maxMultiplierX100: null,
        eventFrom: null,
        eventTo: null,
      },
      roundsIncluded: n,
      distinctSources: n > 0 ? 1 : 0,
      eventTime: { withEventAt: 0, withoutEventAt: n, earliestEventAt: null, latestEventAt: null },
      exclusions: [],
      ...dataset,
    },
    ...computeAnalytics(frequencies),
    method: ANALYTICS_METHOD,
  });
}

const POPULATED = [
  { multiplierX100: 100, count: 2 },
  { multiplierX100: 150, count: 3 },
  { multiplierX100: 250, count: 4 },
  { multiplierX100: 1200, count: 1 },
];

function stub(analytics: (url: URL) => Response | Promise<Response>) {
  const calls: URL[] = [];
  vi.stubGlobal(
    'fetch',
    vi.fn(async (input: RequestInfo | URL) => {
      const url = new URL(typeof input === 'string' ? input : input.toString(), 'http://localhost');
      calls.push(url);
      if (url.pathname === '/api/analytics') return analytics(url);
      if (url.pathname === '/api/health') return new Response(JSON.stringify(HEALTH_OK));
      if (url.pathname === '/api/rounds/sources')
        return new Response(JSON.stringify({ items: [{ source: 'synthetic-ui', rounds: 10 }] }));
      return new Response(JSON.stringify({ error: { code: 'not_found', message: 'nope' } }), {
        status: 404,
      });
    }),
  );
  return calls;
}
const ok = (body: unknown) => new Response(JSON.stringify(body), { status: 200 });

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe('Analytics page', () => {
  it('is reachable from the navigation', async () => {
    stub(() => ok(response([])));
    renderAt('/');
    const nav = screen.getByRole('navigation', { name: 'Primary' });
    expect(within(nav).getByRole('link', { name: 'Analytics' }).getAttribute('href')).toBe(
      '/analytics',
    );
  });

  it('shows a loading state, then metrics with their denominators', async () => {
    let release: (r: Response) => void = () => {};
    stub(() => new Promise<Response>((resolve) => (release = resolve)));
    renderAt('/analytics');
    expect(screen.getByText('Calculating…')).toBeTruthy();
    await act(async () => release(ok(response(POPULATED))));

    expect(await screen.findByText(/round\(s\) included/)).toBeTruthy();
    expect(screen.getByText(/Every proportion below uses 10 as its denominator/)).toBeTruthy();
    expect(screen.getByText('2.85x / 1.50x')).toBeTruthy(); // mean 2850/10 = 285 x100; median (lower middle) 1.50x
    expect(screen.getByText('1.00x / 12.00x')).toBeTruthy();

    const table = screen.getByRole('table', {
      name: /Observed share of rounds at or above each threshold/,
    });
    const row = within(table).getByText('≥ 2.00x').closest('tr')!;
    expect(
      within(row)
        .getAllByRole('cell')
        .map((c) => c.textContent),
    ).toEqual(['≥ 2.00x', '5', '10', '50.0%', expect.stringMatching(/^\d+\.\d% – \d+\.\d%$/)]);
  });

  it('renders an accessible histogram with a table view', async () => {
    stub(() => ok(response(POPULATED)));
    renderAt('/analytics');
    const list = await screen.findByRole('list', {
      name: /Bar chart of rounds per multiplier bin, 10 rounds in total/,
    });
    expect(
      within(list).getByRole('listitem', { name: '1.00x: 2 round(s) · 20.0% of 10' }),
    ).toBeTruthy();
    expect(
      within(list).getByRole('listitem', { name: '≥ 100.00x: 0 round(s) · 0.0% of 10' }),
    ).toBeTruthy();
    const bin = within(list).getByRole('listitem', { name: /^1\.50x–1\.99x/ });
    fireEvent.focus(bin);
    expect(within(bin).getByRole('tooltip').textContent).toContain('3 round(s) · 30.0% of 10');
    const table = screen.getByRole('table', { name: 'Rounds per multiplier bin' });
    expect(within(table).getByText('Bin (lower inclusive, upper exclusive)')).toBeTruthy();
  });

  it('always shows the interpretation caution', async () => {
    stub(() => ok(response(POPULATED)));
    renderAt('/analytics');
    await screen.findByText(/round\(s\) included/);
    expect(
      screen.getAllByText(
        'These figures describe the selected historical records. They do not predict the next multiplier or demonstrate that a strategy will be profitable.',
      ).length,
    ).toBeGreaterThan(0);
    expect(screen.getByText(/sampling uncertainty only/)).toBeTruthy();
  });

  it('shows an honest empty state with no data and no example numbers', async () => {
    stub(() => ok(response([])));
    renderAt('/analytics');
    expect(await screen.findByText('No rounds recorded yet')).toBeTruthy();
    expect(screen.getByText(/no example data is shown/)).toBeTruthy();
    const table = screen.getByRole('table', { name: /Observed share/ });
    for (const row of within(table).getAllByRole('row').slice(1)) {
      const cells = within(row)
        .getAllByRole('cell')
        .map((c) => c.textContent);
      expect(cells.slice(1)).toEqual(['0', '0', '—', '—']);
    }
    expect(screen.queryByRole('list', { name: /Bar chart/ })).toBeNull();
  });

  it('shows a single-round dataset', async () => {
    stub(() => ok(response([{ multiplierX100: 333, count: 1 }])));
    renderAt('/analytics');
    // Mean/median and min/max are both 3.33x for a single round.
    expect(await screen.findAllByText('3.33x / 3.33x')).toHaveLength(2);
    expect(screen.getByText(/Every proportion below uses 1 as its denominator/)).toBeTruthy();
  });

  it('shows data-quality exclusions', async () => {
    stub(() =>
      ok(
        response(POPULATED, {
          eventTime: {
            withEventAt: 7,
            withoutEventAt: 3,
            earliestEventAt: null,
            latestEventAt: null,
          },
          exclusions: [
            {
              reason: 'no_event_time_with_date_filter',
              count: 4,
              description: 'Rounds without an event time are excluded.',
            },
          ],
        }),
      ),
    );
    renderAt('/analytics');
    const panel = await screen.findByRole('region', { name: 'Data quality' });
    expect(within(panel).getByText('3')).toBeTruthy();
    expect(
      within(panel).getByText(/excluded: Rounds without an event time are excluded\./),
    ).toBeTruthy();
  });

  it('sends filter changes to the API and resets them', async () => {
    const calls = stub(() => ok(response([])));
    renderAt('/analytics');
    await screen.findByText('No rounds recorded yet');
    fireEvent.change(screen.getByLabelText(/^Source/), { target: { value: 'synthetic-ui' } });
    fireEvent.change(screen.getByLabelText(/^Min multiplier/), { target: { value: '1.5' } });
    fireEvent.change(screen.getByLabelText(/^Thresholds/), { target: { value: '2, 10' } });
    fireEvent.click(screen.getByRole('button', { name: 'Apply' }));
    expect(await screen.findByText('No rounds match these filters')).toBeTruthy();
    const last = calls.filter((c) => c.pathname === '/api/analytics').at(-1)!;
    expect(Object.fromEntries(last.searchParams)).toEqual({
      source: 'synthetic-ui',
      minMultiplier: '1.5',
      thresholds: '2, 10',
    });
    fireEvent.click(screen.getByRole('button', { name: 'Reset' }));
    expect(await screen.findByText('No rounds recorded yet')).toBeTruthy();
    expect(calls.filter((c) => c.pathname === '/api/analytics').at(-1)!.search).toBe('');
  });

  it('shows server validation errors', async () => {
    stub(
      () =>
        new Response(
          JSON.stringify({
            error: {
              code: 'validation_error',
              message: 'Request validation failed',
              details: [{ path: 'thresholds', message: 'bad' }],
            },
          }),
          { status: 400 },
        ),
    );
    renderAt('/analytics?thresholds=2.345');
    expect(await screen.findByText('Request validation failed')).toBeTruthy();
  });

  it('shows an error when the API is unreachable', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => Promise.reject(new TypeError('Failed to fetch'))),
    );
    renderAt('/analytics');
    const alerts = await screen.findAllByRole('alert');
    expect(alerts.some((a) => /not reachable/.test(a.textContent ?? ''))).toBe(true);
  });
});

describe('Analytics filter inputs', () => {
  it('re-sync with the URL when filters change outside the form (no stale inputs)', async () => {
    const calls = stub(() => ok(response([])));
    renderAt('/analytics?minMultiplier=2&source=synthetic-ui');
    await screen.findByText('No rounds match these filters');
    expect((screen.getByLabelText(/^Min multiplier/) as HTMLInputElement).value).toBe('2');
    fireEvent.click(
      within(screen.getByRole('navigation', { name: 'Primary' })).getByRole('link', {
        name: 'Analytics',
      }),
    );
    expect(await screen.findByText('No rounds recorded yet')).toBeTruthy();
    expect((screen.getByLabelText(/^Min multiplier/) as HTMLInputElement).value).toBe('');
    expect((screen.getByLabelText(/^Source/) as HTMLSelectElement).value).toBe('');
    expect(calls.filter((c) => c.pathname === '/api/analytics').at(-1)!.search).toBe('');
  });

  it('keeps typed but unapplied input while the URL is unchanged', async () => {
    stub(() => ok(response([])));
    renderAt('/analytics');
    await screen.findByText('No rounds recorded yet');
    fireEvent.change(screen.getByLabelText(/^Max multiplier/), { target: { value: '5' } });
    expect((screen.getByLabelText(/^Max multiplier/) as HTMLInputElement).value).toBe('5');
  });
});
