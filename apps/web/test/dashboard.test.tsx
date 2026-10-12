import { cleanup, screen, within } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { EMPTY_OVERVIEW, HEALTH_OK, renderAt, stubApi } from './renderApp';

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe('Overview page', () => {
  it('shows honest empty states for a new database', async () => {
    stubApi({
      '/api/health': HEALTH_OK,
      '/api/overview': EMPTY_OVERVIEW,
      '/api/rounds': { items: [], total: 0, limit: 10, offset: 0 },
    });
    renderAt('/');

    expect(
      await screen.findByText('No rounds recorded yet', { selector: 'p.text-xs' }),
    ).toBeTruthy();
    const recent = screen.getByRole('region', { name: 'Recent rounds' });
    expect(await within(recent).findByText('No rounds recorded yet')).toBeTruthy();
    expect(screen.getByText('No completed simulation yet · virtual funds only')).toBeTruthy();
    expect(screen.getByText('No imports yet')).toBeTruthy();
    expect(screen.getByText(/No simulations run yet/)).toBeTruthy();
  });

  it('always shows research mode and never claims a live connection', async () => {
    stubApi({
      '/api/health': HEALTH_OK,
      '/api/overview': EMPTY_OVERVIEW,
      '/api/rounds': { items: [], total: 0, limit: 10, offset: 0 },
    });
    renderAt('/');
    expect(screen.getByText('Research & simulation mode')).toBeTruthy();
    const live = screen.getByRole('region', { name: 'Live data' });
    expect(within(live).getByText('Not connected.')).toBeTruthy();
    expect(await screen.findByText(/Local API ok/)).toBeTruthy();
  });

  it('shows an error instead of zeros when the API is unreachable', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => Promise.reject(new TypeError('Failed to fetch'))),
    );
    renderAt('/');
    const alerts = await screen.findAllByRole('alert');
    expect(alerts.length).toBeGreaterThan(0);
    expect(alerts[0]?.textContent).toMatch(/not reachable/);
    expect(screen.queryByText('Historical rounds')).toBeNull();
    expect(await screen.findByText('Local API unreachable')).toBeTruthy();
  });

  it('rejects malformed API responses rather than rendering them', async () => {
    stubApi({
      '/api/health': HEALTH_OK,
      '/api/overview': { rounds: 'lots' },
      '/api/rounds': { items: [], total: 0, limit: 10, offset: 0 },
    });
    renderAt('/');
    expect(await screen.findByText('The API returned an unexpected response shape')).toBeTruthy();
  });
});

describe('Overview provenance wording', () => {
  it('describes the latest timestamp as when data was added, not when a round happened', async () => {
    stubApi({
      '/api/health': HEALTH_OK,
      '/api/overview': {
        ...EMPTY_OVERVIEW,
        rounds: { total: 3, distinctSources: 1, latestObservedAt: '2026-01-02T00:00:00.000Z' },
      },
      '/api/rounds': { items: [], total: 0, limit: 10, offset: 0 },
    });
    renderAt('/');
    expect(await screen.findByText(/1 source\(s\) · last added to this app/)).toBeTruthy();
  });
});
