import { useState } from 'react';
import { api } from '../api/client';
import { useApi } from '../api/useApi';
import { EmptyState } from '../components/EmptyState';
import { ErrorNotice } from '../components/ErrorNotice';
import { PageHeader } from '../components/PageHeader';
import { Panel } from '../components/Panel';
import { PlannedBadge } from '../components/PlannedBadge';
import { RoundsTable } from '../components/RoundsTable';
import { formatCount } from '../lib/format';

const PAGE_SIZE = 50;

export function RoundsPage() {
  const [offset, setOffset] = useState(0);
  const state = useApi((signal) => api.rounds(PAGE_SIZE, offset, signal), [offset]);

  return (
    <>
      <PageHeader
        title="Round history"
        description="Recorded crash multipliers with their source and provenance. This is a historical record; it is not used to predict upcoming rounds."
      >
        <div className="flex gap-2">
          <PlannedBadge>Import: planned</PlannedBadge>
          <PlannedBadge>Manual entry: planned</PlannedBadge>
        </div>
      </PageHeader>
      <Panel title="Stored rounds">
        {state.status === 'loading' ? (
          <p className="text-sm text-slate-500">Loading rounds…</p>
        ) : null}
        {state.status === 'error' ? <ErrorNotice message={state.message} /> : null}
        {state.status === 'success' && state.data.total === 0 ? (
          <EmptyState title="No rounds recorded yet">
            The database is empty. Rounds will only ever come from documented, permitted sources or
            your own manual entries; this application does not generate or simulate round history.
          </EmptyState>
        ) : null}
        {state.status === 'success' && state.data.total > 0 ? (
          <>
            <RoundsTable rounds={state.data.items} />
            <div className="mt-4 flex items-center justify-between text-xs text-slate-500">
              <span>
                Showing {formatCount(offset + 1)}–{formatCount(offset + state.data.items.length)} of{' '}
                {formatCount(state.data.total)}
              </span>
              <div className="flex gap-2">
                <button
                  type="button"
                  className="rounded px-2 py-1 ring-1 ring-slate-700 disabled:opacity-40"
                  disabled={offset === 0}
                  onClick={() => setOffset(Math.max(0, offset - PAGE_SIZE))}
                >
                  Previous
                </button>
                <button
                  type="button"
                  className="rounded px-2 py-1 ring-1 ring-slate-700 disabled:opacity-40"
                  disabled={offset + PAGE_SIZE >= state.data.total}
                  onClick={() => setOffset(offset + PAGE_SIZE)}
                >
                  Next
                </button>
              </div>
            </div>
          </>
        ) : null}
      </Panel>
    </>
  );
}
