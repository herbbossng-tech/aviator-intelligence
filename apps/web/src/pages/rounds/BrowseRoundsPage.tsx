import { useState, type FormEvent } from 'react';
import { Link, useSearchParams } from 'react-router';
import { parseMultiplierInput } from '@aviator/shared';
import { api, type RoundFilters } from '../../api/client';
import { useApi } from '../../api/useApi';
import { EmptyState } from '../../components/EmptyState';
import { ErrorNotice } from '../../components/ErrorNotice';
import { FormField, inputClass } from '../../components/FormField';
import { Pagination } from '../../components/Pagination';
import { Panel } from '../../components/Panel';
import { RoundsTable } from '../../components/RoundsTable';

const PAGE_SIZE = 50;
const SORTS = [
  { value: 'recorded_desc', label: 'Most recently recorded' },
  { value: 'event_desc', label: 'Event time, newest first' },
  { value: 'event_asc', label: 'Event time, oldest first' },
] as const;
type Sort = (typeof SORTS)[number]['value'];

function readFilters(params: URLSearchParams): RoundFilters {
  const sort = params.get('sort');
  const importId = Number(params.get('importId'));
  return {
    limit: PAGE_SIZE,
    offset: Math.max(0, Number(params.get('offset')) || 0),
    source: params.get('source') || undefined,
    q: params.get('q') || undefined,
    importId: Number.isInteger(importId) && importId > 0 ? importId : undefined,
    minMultiplier: params.get('minMultiplier') || undefined,
    maxMultiplier: params.get('maxMultiplier') || undefined,
    sort: SORTS.some((s) => s.value === sort) ? (sort as Sort) : undefined,
  };
}

export function BrowseRoundsPage() {
  const [params, setParams] = useSearchParams();
  const filters = readFilters(params);
  const key = params.toString();
  const rounds = useApi((signal) => api.rounds(filters, signal), [key]);
  const sources = useApi((signal) => api.roundSources(signal));

  const [draft, setDraft] = useState({
    source: filters.source ?? '',
    q: filters.q ?? '',
    minMultiplier: filters.minMultiplier ?? '',
    maxMultiplier: filters.maxMultiplier ?? '',
    sort: filters.sort ?? 'recorded_desc',
  });
  const [errors, setErrors] = useState<Record<string, string>>({});
  const filtered = Boolean(
    filters.source ||
    filters.q ||
    filters.importId ||
    filters.minMultiplier ||
    filters.maxMultiplier,
  );

  const apply = (event: FormEvent) => {
    event.preventDefault();
    const next: Record<string, string> = {};
    for (const field of ['minMultiplier', 'maxMultiplier'] as const) {
      if (draft[field].trim() !== '') {
        const parsed = parseMultiplierInput(draft[field]);
        if (!parsed.ok) next[field] = parsed.issue.message.replace(/^multiplier/, 'value');
      }
    }
    setErrors(next);
    if (Object.keys(next).length > 0) return;
    const search = new URLSearchParams();
    for (const [k, v] of Object.entries(draft)) {
      if (v.trim() !== '' && !(k === 'sort' && v === 'recorded_desc')) search.set(k, v.trim());
    }
    if (filters.importId) search.set('importId', String(filters.importId));
    setParams(search);
  };

  const reset = () => {
    setDraft({ source: '', q: '', minMultiplier: '', maxMultiplier: '', sort: 'recorded_desc' });
    setErrors({});
    setParams(new URLSearchParams());
  };

  const goTo = (offset: number) => {
    const next = new URLSearchParams(params);
    if (offset === 0) next.delete('offset');
    else next.set('offset', String(offset));
    setParams(next);
  };

  return (
    <div className="flex flex-col gap-6">
      <Panel title="Filters">
        <form
          onSubmit={apply}
          className="grid gap-4 sm:grid-cols-2 lg:grid-cols-5"
          aria-label="Round filters"
        >
          <FormField id="filter-source" label="Source">
            {(p) => (
              <select
                {...p}
                className={inputClass}
                value={draft.source}
                onChange={(e) => setDraft({ ...draft, source: e.target.value })}
              >
                <option value="">All sources</option>
                {sources.status === 'success'
                  ? sources.data.items.map((s) => (
                      <option key={s.source} value={s.source}>
                        {s.source} ({s.rounds})
                      </option>
                    ))
                  : null}
              </select>
            )}
          </FormField>
          <FormField id="filter-q" label="Source round ID contains">
            {(p) => (
              <input
                {...p}
                className={inputClass}
                value={draft.q}
                maxLength={64}
                onChange={(e) => setDraft({ ...draft, q: e.target.value })}
              />
            )}
          </FormField>
          <FormField id="filter-min" label="Min multiplier" error={errors.minMultiplier}>
            {(p) => (
              <input
                {...p}
                className={inputClass}
                inputMode="decimal"
                placeholder="e.g. 2.00"
                value={draft.minMultiplier}
                onChange={(e) => setDraft({ ...draft, minMultiplier: e.target.value })}
              />
            )}
          </FormField>
          <FormField id="filter-max" label="Max multiplier" error={errors.maxMultiplier}>
            {(p) => (
              <input
                {...p}
                className={inputClass}
                inputMode="decimal"
                placeholder="e.g. 10.00"
                value={draft.maxMultiplier}
                onChange={(e) => setDraft({ ...draft, maxMultiplier: e.target.value })}
              />
            )}
          </FormField>
          <FormField id="filter-sort" label="Sort">
            {(p) => (
              <select
                {...p}
                className={inputClass}
                value={draft.sort}
                onChange={(e) => setDraft({ ...draft, sort: e.target.value as Sort })}
              >
                {SORTS.map((s) => (
                  <option key={s.value} value={s.value}>
                    {s.label}
                  </option>
                ))}
              </select>
            )}
          </FormField>
          <div className="flex flex-wrap items-center gap-2 sm:col-span-2 lg:col-span-5">
            <button
              type="submit"
              className="rounded-md bg-sky-600 px-3 py-2 text-sm font-medium text-white hover:bg-sky-500"
            >
              Apply filters
            </button>
            <button
              type="button"
              onClick={reset}
              className="rounded-md px-3 py-2 text-sm text-slate-300 ring-1 ring-slate-700 hover:bg-slate-800"
            >
              Reset
            </button>
            {filters.importId ? (
              <span className="text-xs text-slate-400">
                Showing rounds from import #{filters.importId}
              </span>
            ) : null}
          </div>
        </form>
      </Panel>

      <Panel title="Stored rounds">
        {rounds.status === 'loading' ? (
          <p className="text-sm text-slate-500">Loading rounds…</p>
        ) : null}
        {rounds.status === 'error' ? <ErrorNotice message={rounds.message} /> : null}
        {rounds.status === 'success' && rounds.data.total === 0 ? (
          filtered ? (
            <EmptyState title="No rounds match these filters">
              Change or reset the filters.
            </EmptyState>
          ) : (
            <EmptyState title="No rounds recorded yet">
              Add rounds you observed with{' '}
              <Link className="text-sky-400" to="/rounds/new">
                manual entry
              </Link>
              , or{' '}
              <Link className="text-sky-400" to="/rounds/import">
                import a CSV or JSON file
              </Link>{' '}
              from a source you are permitted to use. This application never generates round
              history.
            </EmptyState>
          )
        ) : null}
        {rounds.status === 'success' && rounds.data.total > 0 ? (
          <>
            <RoundsTable rounds={rounds.data.items} caption="Stored rounds" />
            <Pagination
              label="Rounds pages"
              offset={filters.offset}
              limit={PAGE_SIZE}
              shown={rounds.data.items.length}
              total={rounds.data.total}
              onChange={goTo}
            />
          </>
        ) : null}
      </Panel>
    </div>
  );
}
