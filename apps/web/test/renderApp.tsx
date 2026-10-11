import { render } from '@testing-library/react';
import { MemoryRouter } from 'react-router';
import { vi } from 'vitest';
import { App } from '../src/App';

export const EMPTY_OVERVIEW = {
  currency: 'NGN',
  rounds: { total: 0, distinctSources: 0, latestObservedAt: null },
  imports: { total: 0, failed: 0, recordsAccepted: 0, recordsRejected: 0, recordsDuplicate: 0 },
  strategies: { total: 0 },
  simulations: { total: 0, completed: 0 },
  latestVirtualBankroll: null,
};

export const HEALTH_OK = {
  status: 'ok',
  service: 'aviator-intelligence-api',
  version: '0.1.0',
  timestamp: '2026-01-01T00:00:00.000Z',
  database: { status: 'ok', schemaVersion: 1 },
};

/** Stubs fetch with a fixed map of path -> JSON body. Unknown paths respond 404. */
export function stubApi(responses: Record<string, unknown>) {
  const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
    const url = typeof input === 'string' ? input : input.toString();
    const path = url.split('?')[0] ?? url;
    if (path in responses) {
      return new Response(JSON.stringify(responses[path]), { status: 200 });
    }
    return new Response(JSON.stringify({ error: { code: 'not_found', message: 'nope' } }), {
      status: 404,
    });
  });
  vi.stubGlobal('fetch', fetchMock);
  return fetchMock;
}

export function renderAt(path: string) {
  return render(
    <MemoryRouter initialEntries={[path]}>
      <App />
    </MemoryRouter>,
  );
}
