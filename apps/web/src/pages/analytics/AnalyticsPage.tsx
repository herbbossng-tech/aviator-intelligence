import { useState, type FormEvent } from 'react';
import { Link, useSearchParams } from 'react-router';
import { formatMultiplierX100, MAX_THRESHOLDS, type AnalyticsResponse } from '@aviator/shared';
import { api, type AnalyticsFilters } from '../../api/client';
import { useApi } from '../../api/useApi';
import { EmptyState } from '../../components/EmptyState';
import { ErrorNotice } from '../../components/ErrorNotice';
import { FormField, inputClass } from '../../components/FormField';
import { HistogramChart } from '../../components/HistogramChart';
import { PageHeader } from '../../components/PageHeader';
import { Panel } from '../../components/Panel';
import { StatCard } from '../../components/StatCard';
import { formatCount, formatTimestamp } from '../../lib/format';
import { formatInterval, formatMeanX100, formatPercent, quantileLabel } from '../../lib/stats';

const FILTER_KEYS = [
  'source',
  'minMultiplier',
  'maxMultiplier',
  'eventFrom',
  'eventTo',
  'thresholds',
] as const;
type FilterKey = (typeof FILTER_KEYS)[number];
type Draft = Record<FilterKey, string>;

function readFilters(params: URLSearchParams): AnalyticsFilters {
  const filters: AnalyticsFilters = {};
  for (const key of FILTER_KEYS) {
    const value = params.get(key);
    if (value) filters[key] = value;
  }
  return filters;
}

function draftFrom(filters: AnalyticsFilters): Draft {
  return Object.fromEntries(FILTER_KEYS.map((k) => [k, filters[k] ?? ''])) as Draft;
}

export const INTERPRETATION_NOTE =
  'These figures describe the selected historical records. They do not predict the next multiplier or demonstrate that a strategy will be profitable.';

export function AnalyticsPage() {
  const [params, setParams] = useSearchParams();
  const filters = readFilters(params);
  const key = params.toString();
  const state = useApi((signal) => api.analytics(filters, signal), [key]);
  const sources = useApi((signal) => api.roundSources(signal));
  const [draft, setDraft] = useState<Draft>(() => draftFrom(filters));
  // When the URL's filters change from outside the form (nav link, back/forward), re-derive
  // the inputs so they never show filters that are not actually applied to the results.
  const [draftKey, setDraftKey] = useState(key);
  if (draftKey !== key) {
    setDraftKey(key);
    setDraft(draftFrom(filters));
  }
  const filtered = Object.keys(filters).length > 0;

  const apply = (event: FormEvent) => {
    event.preventDefault();
    const next = new URLSearchParams();
    for (const k of FILTER_KEYS) {
      const value = draft[k].trim();
      if (value) next.set(k, value);
    }
    setParams(next);
  };
  const reset = () => {
    setDraft(draftFrom({}));
    setParams(new URLSearchParams());
  };
  const field = (k: FilterKey) => ({
    value: draft[k],
    onChange: (e: { target: { value: string } }) =>
      setDraft((d) => ({ ...d, [k]: e.target.value })),
  });

  return (
    <>
      <PageHeader
        title="Historical analytics"
        description="Descriptive statistics of the stored rounds you select. Every proportion shows its denominator."
      />

      <div
        role="note"
        className="mb-6 rounded-md border border-amber-400/30 bg-amber-400/5 px-4 py-3 text-sm text-amber-200"
      >
        {INTERPRETATION_NOTE}
      </div>

      <Panel title="Dataset" subtitle="Filters apply to every figure on this page">
        <form
          onSubmit={apply}
          aria-label="Analytics filters"
          className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3"
        >
          <FormField id="an-source" label="Source">
            {(p) => (
              <select {...p} className={inputClass} {...field('source')}>
                <option value="">All sources</option>
                {sources.status === 'success'
                  ? sources.data.items.map((s) => (
                      <option key={s.source} value={s.source}>
                        {s.source} ({formatCount(s.rounds)})
                      </option>
                    ))
                  : null}
              </select>
            )}
          </FormField>
          <FormField id="an-min" label="Min multiplier" hint="Inclusive, e.g. 1.00">
            {(p) => (
              <input
                {...p}
                className={inputClass}
                inputMode="decimal"
                {...field('minMultiplier')}
              />
            )}
          </FormField>
          <FormField id="an-max" label="Max multiplier" hint="Inclusive, e.g. 100">
            {(p) => (
              <input
                {...p}
                className={inputClass}
                inputMode="decimal"
                {...field('maxMultiplier')}
              />
            )}
          </FormField>
          <FormField
            id="an-from"
            label="Event time from"
            hint="Inclusive; ISO-8601 with time zone, e.g. 2026-01-01T00:00:00Z"
          >
            {(p) => (
              <input {...p} className={inputClass} autoComplete="off" {...field('eventFrom')} />
            )}
          </FormField>
          <FormField
            id="an-to"
            label="Event time before"
            hint="Exclusive; rounds without an event time are excluded when a date is set"
          >
            {(p) => (
              <input {...p} className={inputClass} autoComplete="off" {...field('eventTo')} />
            )}
          </FormField>
          <FormField
            id="an-thresholds"
            label="Thresholds"
            hint={`Comma-separated, up to ${MAX_THRESHOLDS}, e.g. 1.5, 2, 10. Default: 1.2, 1.5, 2, 3, 5, 10, 20`}
          >
            {(p) => (
              <input {...p} className={inputClass} autoComplete="off" {...field('thresholds')} />
            )}
          </FormField>
          <div className="flex flex-wrap gap-2 sm:col-span-2 lg:col-span-3">
            <button
              type="submit"
              className="rounded-md bg-sky-600 px-3 py-2 text-sm font-medium text-white hover:bg-sky-500"
            >
              Apply
            </button>
            <button
              type="button"
              onClick={reset}
              className="rounded-md px-3 py-2 text-sm text-slate-300 ring-1 ring-slate-700 hover:bg-slate-800"
            >
              Reset
            </button>
          </div>
        </form>
      </Panel>

      <div className="mt-6">
        {state.status === 'loading' ? <p className="text-sm text-slate-500">Calculating…</p> : null}
        {state.status === 'error' ? <ErrorNotice message={state.message} /> : null}
        {state.status === 'success' ? (
          <AnalyticsResults data={state.data} filtered={filtered} />
        ) : null}
      </div>
    </>
  );
}

function AnalyticsResults({ data, filtered }: { data: AnalyticsResponse; filtered: boolean }) {
  const { dataset, summary } = data;
  const n = dataset.roundsIncluded;
  const headline = data.thresholds.find((t) => t.thresholdX100 === 200) ?? data.thresholds[0];

  return (
    <div className="flex flex-col gap-6">
      <p className="text-sm text-slate-300" aria-live="polite">
        <strong className="font-semibold text-slate-100">{formatCount(n)}</strong> round(s) included
        {filtered ? ' after filtering' : ''} · {formatCount(dataset.distinctSources)} source(s).
        Every proportion below uses {formatCount(n)} as its denominator.
      </p>

      {summary === null ? (
        <EmptyState title={filtered ? 'No rounds match these filters' : 'No rounds recorded yet'}>
          {filtered ? (
            'Change or reset the filters.'
          ) : (
            <>
              Analytics only use rounds you have stored.{' '}
              <Link className="text-sky-400" to="/rounds/import">
                Import a file
              </Link>{' '}
              or{' '}
              <Link className="text-sky-400" to="/rounds/new">
                add a round
              </Link>
              ; no example data is shown.
            </>
          )}
        </EmptyState>
      ) : (
        <>
          <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-4">
            <StatCard
              label="Rounds"
              value={formatCount(summary.count)}
              detail={`${formatCount(dataset.distinctSources)} source(s)`}
            />
            <StatCard
              label="Mean / median"
              value={`${formatMeanX100(summary.meanX100)} / ${formatMultiplierX100(summary.medianX100)}`}
              detail="Mean shown to 0.01x; median is the lower middle value for an even count"
            />
            <StatCard
              label="Min / max"
              value={`${formatMultiplierX100(summary.minX100)} / ${formatMultiplierX100(summary.maxX100)}`}
              detail="Observed extremes in the selection"
            />
            {headline ? (
              <StatCard
                label={`Observed share ≥ ${formatMultiplierX100(headline.thresholdX100)}`}
                value={formatPercent(headline.proportion)}
                detail={`${formatCount(headline.count)} of ${formatCount(headline.denominator)} · 95% CI ${formatInterval(headline.ci95)}`}
              />
            ) : null}
          </div>

          <div className="grid gap-6 xl:grid-cols-2">
            <Panel
              title="Multiplier distribution"
              subtitle={`Rounds per bin · bins are lower-inclusive, upper-exclusive · n = ${formatCount(n)}`}
            >
              <HistogramChart histogram={data.histogram} />
            </Panel>
            <Panel title="Quantiles" subtitle="Nearest-rank: each value is an observed multiplier">
              <dl className="grid grid-cols-3 gap-3 sm:grid-cols-6">
                {summary.quantiles.map((q) => (
                  <div key={q.levelBps}>
                    <dt className="text-xs text-slate-500">{quantileLabel(q.levelBps)}</dt>
                    <dd className="mt-1 font-mono text-sm text-slate-100 tabular-nums">
                      {formatMultiplierX100(q.valueX100)}
                    </dd>
                  </div>
                ))}
              </dl>
            </Panel>
          </div>
        </>
      )}

      <Panel
        title="Observed share at or above each threshold"
        subtitle="Empirical P(M ≥ t) with a 95% Wilson score interval"
      >
        <div className="overflow-x-auto">
          <table className="w-full min-w-[36rem] text-left text-sm">
            <caption className="sr-only">
              Observed share of rounds at or above each threshold
            </caption>
            <thead className="text-xs text-slate-500 uppercase">
              <tr>
                <th scope="col" className="py-2 pr-4 font-medium">
                  Threshold t
                </th>
                <th scope="col" className="py-2 pr-4 text-right font-medium">
                  Rounds ≥ t
                </th>
                <th scope="col" className="py-2 pr-4 text-right font-medium">
                  Denominator
                </th>
                <th scope="col" className="py-2 pr-4 text-right font-medium">
                  Observed share
                </th>
                <th scope="col" className="py-2 text-right font-medium">
                  95% CI (Wilson)
                </th>
              </tr>
            </thead>
            <tbody className="divide-y divide-slate-800 font-mono tabular-nums">
              {data.thresholds.map((t) => (
                <tr key={t.thresholdX100}>
                  <td className="py-2 pr-4 text-slate-100">
                    ≥ {formatMultiplierX100(t.thresholdX100)}
                  </td>
                  <td className="py-2 pr-4 text-right text-slate-300">{formatCount(t.count)}</td>
                  <td className="py-2 pr-4 text-right text-slate-400">
                    {formatCount(t.denominator)}
                  </td>
                  <td className="py-2 pr-4 text-right text-slate-100">
                    {formatPercent(t.proportion)}
                  </td>
                  <td className="py-2 text-right text-slate-400">{formatInterval(t.ci95)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
        <p className="mt-3 text-xs text-slate-500">
          The interval reflects sampling uncertainty only, under the assumption that the selected
          rounds are independent draws from an unchanging process. It does not correct data-quality
          problems and does not make the share a forecast. With no rounds, no share or interval is
          shown.
        </p>
      </Panel>

      <div className="grid gap-6 lg:grid-cols-2">
        <Panel title="Data quality" subtitle="What the selection contains and leaves out">
          <dl className="grid grid-cols-2 gap-4 text-sm">
            <div>
              <dt className="text-xs text-slate-500">Rounds included</dt>
              <dd className="mt-1 font-mono text-slate-100 tabular-nums">{formatCount(n)}</dd>
            </div>
            <div>
              <dt className="text-xs text-slate-500">Without an event time</dt>
              <dd className="mt-1 font-mono text-slate-100 tabular-nums">
                {formatCount(dataset.eventTime.withoutEventAt)}
              </dd>
            </div>
            <div>
              <dt className="text-xs text-slate-500">Earliest event time</dt>
              <dd className="mt-1 text-slate-300">
                {formatTimestamp(dataset.eventTime.earliestEventAt)}
              </dd>
            </div>
            <div>
              <dt className="text-xs text-slate-500">Latest event time</dt>
              <dd className="mt-1 text-slate-300">
                {formatTimestamp(dataset.eventTime.latestEventAt)}
              </dd>
            </div>
          </dl>
          {dataset.exclusions.length > 0 ? (
            <ul className="mt-4 space-y-1 text-sm text-amber-200">
              {dataset.exclusions.map((e) => (
                <li key={e.reason}>
                  <strong className="font-mono">{formatCount(e.count)}</strong> excluded:{' '}
                  {e.description}
                </li>
              ))}
            </ul>
          ) : (
            <p className="mt-4 text-sm text-slate-400">No matching rounds were excluded.</p>
          )}
        </Panel>
        <Panel title="How to read this">
          <ul className="list-disc space-y-1 pl-5 text-sm text-slate-400">
            <li>
              Statistics ignore round order entirely: neither event time nor recording order affects
              them. Event times are used only for the optional date filter, and rounds without one
              are never given an invented time.
            </li>
            <li>
              “Observed share ≥ t” counts rounds whose multiplier is greater than or equal to t.
            </li>
            <li>
              The mean is pulled up strongly by rare very high multipliers; the median and quantiles
              are often more representative.
            </li>
            <li>{INTERPRETATION_NOTE}</li>
          </ul>
          <Link
            to="/methodology"
            className="mt-3 inline-block text-xs text-sky-400 hover:text-sky-300"
          >
            Methodology &amp; limits
          </Link>
        </Panel>
      </div>
    </div>
  );
}
