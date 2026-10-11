import { act, cleanup, fireEvent, screen, waitFor, within } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { HEALTH_OK, renderAt } from './renderApp';

// SYNTHETIC TEST FIXTURES: invented API responses, not real Aviator history.

type Handler = (url: URL, init: RequestInit | undefined) => Response | Promise<Response>;

const json = (status: number, body: unknown) => new Response(JSON.stringify(body), { status });
const apiError = (status: number, code: string, message: string, details?: unknown) =>
  json(status, { error: details === undefined ? { code, message } : { code, message, details } });

const EMPTY_ROUNDS = { items: [], total: 0, limit: 50, offset: 0 };

function round(id: number, overrides: Record<string, unknown> = {}) {
  return {
    id,
    multiplierX100: 150 + id,
    source: 'synthetic-ui-fixture',
    sourceRoundId: `SYN-${id}`,
    observedAt: '2026-01-01T00:00:00.000Z',
    eventAt: null,
    importId: null,
    createdAt: '2026-01-01T00:00:00.000Z',
    ...overrides,
  };
}

/** Stubs fetch; `routes` maps "METHOD /path" to a handler. Unmatched requests get a 404 error envelope. */
function stubApi(routes: Record<string, Handler>) {
  const calls: { method: string; url: URL; body: unknown }[] = [];
  const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = new URL(typeof input === 'string' ? input : input.toString(), 'http://localhost');
    const method = init?.method ?? 'GET';
    calls.push({
      method,
      url,
      body: typeof init?.body === 'string' ? JSON.parse(init.body) : undefined,
    });
    const handler = routes[`${method} ${url.pathname}`];
    if (handler) return handler(url, init);
    if (url.pathname === '/api/health') return json(200, HEALTH_OK);
    if (url.pathname === '/api/rounds/sources') return json(200, { items: [] });
    return apiError(404, 'not_found', 'nope');
  });
  vi.stubGlobal('fetch', fetchMock);
  return calls;
}

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe('Browse rounds', () => {
  it('shows an empty state with routes to add data', async () => {
    stubApi({ 'GET /api/rounds': () => json(200, EMPTY_ROUNDS) });
    renderAt('/rounds');
    expect(await screen.findByText('No rounds recorded yet')).toBeTruthy();
    expect(screen.getByRole('link', { name: 'manual entry' }).getAttribute('href')).toBe(
      '/rounds/new',
    );
    expect(
      screen.getByRole('link', { name: 'import a CSV or JSON file' }).getAttribute('href'),
    ).toBe('/rounds/import');
  });

  it('renders rounds with provenance and paginates', async () => {
    const calls = stubApi({
      'GET /api/rounds': (url) => {
        const offset = Number(url.searchParams.get('offset') ?? 0);
        const items = Array.from({ length: offset === 0 ? 50 : 10 }, (_, i) =>
          round(
            offset + i + 1,
            i === 0 ? { importId: 7, eventAt: '2026-01-31T14:05:09.000Z' } : {},
          ),
        );
        return json(200, { items, total: 60, limit: 50, offset });
      },
    });
    renderAt('/rounds');
    expect(await screen.findByText('Showing 1–50 of 60')).toBeTruthy();
    expect(screen.getByText('1.51x')).toBeTruthy();
    expect(screen.getByRole('link', { name: 'import #7' })).toBeTruthy();
    expect(screen.getAllByText('manual entry').length).toBeGreaterThan(0);
    fireEvent.click(screen.getByRole('button', { name: 'Next' }));
    expect(await screen.findByText('Showing 51–60 of 60')).toBeTruthy();
    expect(
      calls.some(
        (c) => c.url.pathname === '/api/rounds' && c.url.searchParams.get('offset') === '50',
      ),
    ).toBe(true);
  });

  it('validates filters on the client and sends them to the API', async () => {
    const calls = stubApi({ 'GET /api/rounds': () => json(200, EMPTY_ROUNDS) });
    renderAt('/rounds');
    await screen.findByText('No rounds recorded yet');
    fireEvent.change(screen.getByLabelText(/Min multiplier/), { target: { value: '2.345' } });
    fireEvent.click(screen.getByRole('button', { name: 'Apply filters' }));
    expect(await screen.findByText(/more than two decimal places/)).toBeTruthy();
    fireEvent.change(screen.getByLabelText(/Min multiplier/), { target: { value: '2' } });
    fireEvent.change(screen.getByLabelText(/Source round ID contains/), {
      target: { value: 'SYN' },
    });
    fireEvent.click(screen.getByRole('button', { name: 'Apply filters' }));
    await screen.findByText('No rounds match these filters');
    const last = calls.filter((c) => c.url.pathname === '/api/rounds').at(-1);
    expect(last?.url.searchParams.get('minMultiplier')).toBe('2');
    expect(last?.url.searchParams.get('q')).toBe('SYN');
  });

  it('shows an error when the API is unreachable', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => Promise.reject(new TypeError('Failed to fetch'))),
    );
    renderAt('/rounds');
    const alerts = await screen.findAllByRole('alert');
    expect(alerts.some((a) => /not reachable/.test(a.textContent ?? ''))).toBe(true);
  });
});

describe('Manual entry', () => {
  const fill = (
    values: Partial<Record<'Multiplier' | 'Source round ID' | 'Event time', string>>,
  ) => {
    for (const [label, value] of Object.entries(values)) {
      fireEvent.change(screen.getByLabelText(new RegExp(`^${label}`)), { target: { value } });
    }
  };
  const save = () => fireEvent.click(screen.getByRole('button', { name: 'Save round' }));

  it('has labelled controls and validates on the client before calling the API', async () => {
    const calls = stubApi({});
    renderAt('/rounds/new');
    expect(screen.getByLabelText(/^Multiplier/).getAttribute('inputmode')).toBe('decimal');
    expect((screen.getByLabelText(/^Source \/ provenance/) as HTMLInputElement).value).toBe(
      'manual entry',
    );
    fill({ Multiplier: '0.5', 'Event time': '2026-01-31T14:05:09' });
    save();
    expect(await screen.findByText(/below the 1.00x minimum/)).toBeTruthy();
    expect(screen.getByText(/must be ISO-8601 with an explicit offset/)).toBeTruthy();
    expect(screen.getByLabelText(/^Multiplier/).getAttribute('aria-invalid')).toBe('true');
    expect(calls.filter((c) => c.method === 'POST')).toHaveLength(0);
  });

  it('saves a round, confirms success and clears only the round fields', async () => {
    const calls = stubApi({
      'POST /api/rounds': () =>
        json(201, {
          round: round(12, {
            multiplierX100: 235,
            source: 'manual entry',
            sourceRoundId: 'SYN-12',
          }),
        }),
    });
    renderAt('/rounds/new');
    fill({ Multiplier: '2.35', 'Source round ID': 'SYN-12' });
    save();
    expect(await screen.findByText(/Saved round #12: 2.35x/)).toBeTruthy();
    expect(calls.find((c) => c.method === 'POST')?.body).toEqual({
      source: 'manual entry',
      multiplier: '2.35',
      sourceRoundId: 'SYN-12',
    });
    expect((screen.getByLabelText(/^Multiplier/) as HTMLInputElement).value).toBe('');
    expect((screen.getByLabelText(/^Source \/ provenance/) as HTMLInputElement).value).toBe(
      'manual entry',
    );
  });

  it('disables the button while saving to prevent double submission', async () => {
    let release: (r: Response) => void = () => {};
    const calls = stubApi({
      'POST /api/rounds': () => new Promise<Response>((resolve) => (release = resolve)),
    });
    renderAt('/rounds/new');
    fill({ Multiplier: '2' });
    save();
    const busy = await screen.findByRole('button', { name: 'Saving…' });
    expect((busy as HTMLButtonElement).disabled).toBe(true);
    fireEvent.click(busy);
    expect(calls.filter((c) => c.method === 'POST')).toHaveLength(1);
    await act(async () => release(json(201, { round: round(1) })));
    expect(await screen.findByText(/Saved round #1/)).toBeTruthy();
  });

  it('keeps the input and shows the reason when the server reports a duplicate', async () => {
    stubApi({
      'POST /api/rounds': () =>
        apiError(
          409,
          'duplicate_source_id',
          'A round with this source and sourceRoundId already exists (round 3).',
        ),
    });
    renderAt('/rounds/new');
    fill({ Multiplier: '2', 'Source round ID': 'SYN-3' });
    save();
    expect(await screen.findByText(/already exists \(round 3\)/)).toBeTruthy();
    expect((screen.getByLabelText(/^Multiplier/) as HTMLInputElement).value).toBe('2');
    expect(screen.queryByText(/Saved round/)).toBeNull();
  });

  it('asks before saving a possible duplicate and resends with explicit confirmation', async () => {
    const calls = stubApi({
      'POST /api/rounds': (_url, init) =>
        JSON.parse(String(init?.body)).allowPossibleDuplicate
          ? json(201, { round: round(4) })
          : apiError(409, 'possible_duplicate', 'possible duplicate'),
    });
    renderAt('/rounds/new');
    fill({ Multiplier: '2', 'Event time': '2026-01-31T14:05:09Z' });
    save();
    fireEvent.click(await screen.findByRole('button', { name: 'Save anyway as a separate round' }));
    expect(await screen.findByText(/Saved round #4/)).toBeTruthy();
    expect(
      calls
        .filter((c) => c.method === 'POST')
        .map((c) => (c.body as Record<string, unknown>).allowPossibleDuplicate),
    ).toEqual([undefined, true]);
  });

  it('maps server-side validation errors to fields', async () => {
    stubApi({
      'POST /api/rounds': () =>
        apiError(400, 'validation_error', 'Request validation failed', [
          { path: 'sourceRoundId', code: 'invalid_source_round_id', message: 'server says no' },
        ]),
    });
    renderAt('/rounds/new');
    fill({ Multiplier: '2', 'Source round ID': 'SYN-1' });
    save();
    expect(await screen.findByText('server says no')).toBeTruthy();
  });

  it('never reports success when the write fails', async () => {
    stubApi({
      'POST /api/rounds': () =>
        apiError(500, 'database_write_failed', 'The round could not be saved. Nothing was stored.'),
    });
    renderAt('/rounds/new');
    fill({ Multiplier: '2' });
    save();
    expect(
      await screen.findByText('The round could not be saved. Nothing was stored.'),
    ).toBeTruthy();
    expect(screen.queryByText(/Saved round/)).toBeNull();
    expect((screen.getByRole('button', { name: 'Save round' }) as HTMLButtonElement).disabled).toBe(
      false,
    );
  });
});

describe('File import', () => {
  const PREVIEW = {
    previewId: '6f1c1a8e-2a7e-4c55-9d1a-0d8f3c0f9b11',
    expiresAt: '2026-01-01T00:15:00.000Z',
    format: 'csv',
    source: 'synthetic-ui-fixture',
    notes: null,
    contentSha256: 'a'.repeat(64),
    alreadyImported: null,
    counts: {
      total: 3,
      new: 2,
      invalid: 1,
      duplicateExisting: 0,
      duplicateInFile: 0,
      possibleDuplicates: 0,
    },
    rows: [
      {
        recordNumber: 1,
        line: 2,
        status: 'new',
        multiplierX100: 150,
        sourceRoundId: 'SYN-1',
        eventAt: null,
        issues: [],
        warnings: [],
      },
      {
        recordNumber: 2,
        line: 3,
        status: 'new',
        multiplierX100: 200,
        sourceRoundId: 'SYN-2',
        eventAt: null,
        issues: [],
        warnings: [],
      },
      {
        recordNumber: 3,
        line: 4,
        status: 'invalid',
        multiplierX100: null,
        sourceRoundId: null,
        eventAt: null,
        issues: [
          {
            code: 'invalid_multiplier',
            field: 'multiplier',
            message: 'multiplier "abc" is not a plain decimal number',
          },
        ],
        warnings: [],
      },
    ],
    rowsTruncated: false,
    issues: [
      {
        code: 'invalid_multiplier',
        field: 'multiplier',
        message: 'multiplier "abc" is not a plain decimal number',
        recordNumber: 3,
        line: 4,
        severity: 'error',
      },
    ],
    issuesTruncated: false,
  };
  const IMPORT = {
    id: 9,
    source: 'synthetic-ui-fixture',
    notes: null,
    sourceKind: 'file_import',
    format: 'csv',
    status: 'completed_with_rejections',
    recordsTotal: 3,
    recordsAccepted: 2,
    recordsRejected: 1,
    recordsDuplicate: 0,
    contentSha256: 'a'.repeat(64),
    errorSummary: null,
    startedAt: '2026-01-01T00:00:00.000Z',
    completedAt: '2026-01-01T00:00:01.000Z',
    importedAt: '2026-01-01T00:00:00.000Z',
  };

  const choose = (file: File) =>
    fireEvent.change(screen.getByLabelText(/^CSV or JSON file/), { target: { files: [file] } });
  const csvFile = () =>
    new File(['multiplier,sourceRoundId\n1.50,SYN-1\n2.00,SYN-2\nabc,\n'], 'rounds.csv', {
      type: 'text/csv',
    });

  it('previews a file with row-level feedback, then confirms it', async () => {
    const calls = stubApi({
      'POST /api/imports/preview': () => json(200, PREVIEW),
      'POST /api/imports': () => json(201, { import: IMPORT, counts: PREVIEW.counts }),
    });
    renderAt('/rounds/import');
    choose(csvFile());
    expect((screen.getByLabelText(/^Format/) as HTMLSelectElement).value).toBe('csv');
    fireEvent.change(screen.getByLabelText(/^Source \/ provenance/), {
      target: { value: 'synthetic-ui-fixture' },
    });
    fireEvent.click(screen.getByRole('button', { name: 'Validate and preview' }));

    const preview = await screen.findByRole('region', { name: 'Step 2: review the preview' });
    expect(within(preview).getByText('New (will be stored)').nextSibling?.textContent).toBe('2');
    expect(within(preview).getByText('Invalid (rejected)').nextSibling?.textContent).toBe('1');
    expect(within(preview).getAllByText(/is not a plain decimal number/).length).toBeGreaterThan(0);
    const sent = calls.find((c) => c.url.pathname === '/api/imports/preview')?.body as Record<
      string,
      unknown
    >;
    expect(sent).toMatchObject({ format: 'csv', source: 'synthetic-ui-fixture', notes: null });
    expect(sent.content).toContain('abc,');

    fireEvent.click(within(preview).getByRole('button', { name: 'Confirm import of 2 round(s)' }));
    expect(await screen.findByText('Import #9 saved.')).toBeTruthy();
    expect(
      calls.find((c) => c.url.pathname === '/api/imports' && c.method === 'POST')?.body,
    ).toEqual({
      previewId: PREVIEW.previewId,
    });
    expect(screen.getByRole('link', { name: 'View imported rounds' }).getAttribute('href')).toBe(
      '/rounds?importId=9',
    );
  });

  it('blocks confirmation for content that was already imported', async () => {
    stubApi({
      'POST /api/imports/preview': () =>
        json(200, {
          ...PREVIEW,
          alreadyImported: { importId: 3, importedAt: '2026-01-01T00:00:00.000Z' },
        }),
    });
    renderAt('/rounds/import');
    choose(csvFile());
    fireEvent.change(screen.getByLabelText(/^Source \/ provenance/), {
      target: { value: 'synthetic-ui-fixture' },
    });
    fireEvent.click(screen.getByRole('button', { name: 'Validate and preview' }));
    expect(await screen.findByText(/already imported \(import #3/)).toBeTruthy();
    expect(
      (screen.getByRole('button', { name: /Confirm import/ }) as HTMLButtonElement).disabled,
    ).toBe(true);
  });

  it('shows file-level errors from the server', async () => {
    stubApi({
      'POST /api/imports/preview': () =>
        apiError(422, 'invalid_header', 'Unknown CSV column "source".', { line: 1 }),
    });
    renderAt('/rounds/import');
    choose(csvFile());
    fireEvent.change(screen.getByLabelText(/^Source \/ provenance/), { target: { value: 'x' } });
    fireEvent.click(screen.getByRole('button', { name: 'Validate and preview' }));
    expect(await screen.findByText('Unknown CSV column "source". (line 1)')).toBeTruthy();
  });

  it('requires a file and a source, and rejects oversized files before uploading', async () => {
    const calls = stubApi({});
    renderAt('/rounds/import');
    fireEvent.click(screen.getByRole('button', { name: 'Validate and preview' }));
    expect(await screen.findByText('Choose a CSV or JSON file')).toBeTruthy();
    expect(screen.getByText('source is required')).toBeTruthy();
    choose(new File(['x'.repeat(2 * 1024 * 1024 + 1)], 'big.csv'));
    fireEvent.change(screen.getByLabelText(/^Source \/ provenance/), { target: { value: 'x' } });
    fireEvent.click(screen.getByRole('button', { name: 'Validate and preview' }));
    expect(await screen.findByText(/the limit is 2,097,152 bytes/)).toBeTruthy();
    expect(calls.filter((c) => c.method === 'POST')).toHaveLength(0);
  });

  it('reports a failed confirmation without claiming success', async () => {
    stubApi({
      'POST /api/imports/preview': () => json(200, PREVIEW),
      'POST /api/imports': () =>
        apiError(
          500,
          'database_write_failed',
          'The import could not be saved. The transaction was rolled back and no records were stored.',
        ),
    });
    renderAt('/rounds/import');
    choose(csvFile());
    fireEvent.change(screen.getByLabelText(/^Source \/ provenance/), {
      target: { value: 'synthetic-ui-fixture' },
    });
    fireEvent.click(screen.getByRole('button', { name: 'Validate and preview' }));
    fireEvent.click(await screen.findByRole('button', { name: 'Confirm import of 2 round(s)' }));
    expect(await screen.findByText(/rolled back and no records were stored/)).toBeTruthy();
    expect(screen.queryByText(/^Import #\d+ saved\./)).toBeNull();
    expect(screen.queryByRole('link', { name: 'View imported rounds' })).toBeNull();
  });
});

describe('Import history', () => {
  it('shows an empty state', async () => {
    stubApi({ 'GET /api/imports': () => json(200, { items: [], total: 0, limit: 20, offset: 0 }) });
    renderAt('/rounds/imports');
    expect(await screen.findByText('No imports yet')).toBeTruthy();
  });

  it('lists imports with their outcome', async () => {
    stubApi({
      'GET /api/imports': () =>
        json(200, {
          items: [
            {
              id: 2,
              source: 'synthetic-ui-fixture',
              notes: 'second try',
              sourceKind: 'file_import',
              format: 'json',
              status: 'failed',
              recordsTotal: 5,
              recordsAccepted: 0,
              recordsRejected: 0,
              recordsDuplicate: 0,
              contentSha256: null,
              errorSummary: 'Database write failed; the transaction was rolled back.',
              startedAt: null,
              completedAt: null,
              importedAt: '2026-01-02T00:00:00.000Z',
            },
          ],
          total: 1,
          limit: 20,
          offset: 0,
        }),
    });
    renderAt('/rounds/imports');
    expect(await screen.findByText('Failed (rolled back)')).toBeTruthy();
    expect(screen.getByText('second try')).toBeTruthy();
    expect(screen.getByText(/#2 · JSON/)).toBeTruthy();
  });
});

describe('Navigation', () => {
  it('exposes the round data sections as links', async () => {
    stubApi({ 'GET /api/rounds': () => json(200, EMPTY_ROUNDS) });
    renderAt('/rounds');
    const nav = screen.getByRole('navigation', { name: 'Round data sections' });
    expect(
      within(nav)
        .getAllByRole('link')
        .map((l) => l.textContent),
    ).toEqual(['Browse', 'Add a round', 'Import file', 'Import history']);
    await waitFor(() => expect(screen.getByText('No rounds recorded yet')).toBeTruthy());
  });
});
