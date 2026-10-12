import { useId, useState } from 'react';
import { histogramBinLabel, type AnalyticsResponse } from '@aviator/shared';
import { formatCount } from '../lib/format';
import { formatPercent } from '../lib/stats';

type Histogram = AnalyticsResponse['histogram'];

/**
 * Counts per multiplier bin as horizontal bars. Bins have deliberately unequal widths
 * (1.00x alone, then wider ranges, then an open-ended tail), so bar length encodes the
 * COUNT in each bin, not a density. Every value is also available in the table view.
 */
export function HistogramChart({ histogram }: { histogram: Histogram }) {
  const titleId = useId();
  const [active, setActive] = useState<number | null>(null);
  const max = Math.max(1, ...histogram.bins.map((b) => b.count));
  const rows = histogram.bins.map((bin) => ({ ...bin, label: histogramBinLabel(bin) }));
  const summary = `Bar chart of rounds per multiplier bin, ${formatCount(histogram.denominator)} rounds in total. ${rows
    .map((r) => `${r.label}: ${formatCount(r.count)}`)
    .join('; ')}.`;

  return (
    <figure className="m-0">
      <figcaption id={titleId} className="sr-only">
        {summary}
      </figcaption>
      <div role="list" aria-labelledby={titleId} className="flex flex-col gap-0.5">
        {rows.map((row, i) => {
          const widthPct = (row.count / max) * 100;
          const detail = `${formatCount(row.count)} round(s) · ${formatPercent(row.proportion)} of ${formatCount(histogram.denominator)}`;
          return (
            <div
              key={row.label}
              role="listitem"
              tabIndex={0}
              aria-label={`${row.label}: ${detail}`}
              onPointerEnter={() => setActive(i)}
              onPointerLeave={() => setActive((a) => (a === i ? null : a))}
              onFocus={() => setActive(i)}
              onBlur={() => setActive((a) => (a === i ? null : a))}
              className="relative grid grid-cols-[6.5rem_1fr_3.5rem] items-center gap-2 rounded px-1 py-1 outline-none focus-visible:ring-1 focus-visible:ring-sky-500 sm:grid-cols-[8rem_1fr_4rem]"
            >
              <span className="truncate text-right font-mono text-xs text-slate-400 tabular-nums">
                {row.label}
              </span>
              <span className="relative h-4 border-l border-slate-700">
                {row.count > 0 ? (
                  <span
                    aria-hidden="true"
                    className={`absolute inset-y-0 left-0 rounded-r ${active === i ? 'bg-sky-500' : 'bg-sky-600'}`}
                    style={{ width: `max(${widthPct}%, 2px)` }}
                  />
                ) : null}
              </span>
              <span className="font-mono text-xs text-slate-300 tabular-nums">
                {formatCount(row.count)}
              </span>
              {active === i ? (
                <span
                  role="tooltip"
                  className="pointer-events-none absolute -top-8 left-1/2 z-10 -translate-x-1/2 rounded-md border border-slate-700 bg-slate-900 px-2 py-1 text-xs whitespace-nowrap text-slate-400 shadow-lg"
                >
                  <strong className="font-semibold text-slate-100">{detail}</strong> · {row.label}
                </span>
              ) : null}
            </div>
          );
        })}
      </div>
      <details className="mt-4 text-xs text-slate-400">
        <summary className="cursor-pointer text-slate-300">Show as table</summary>
        <table className="mt-2 w-full text-left">
          <caption className="sr-only">Rounds per multiplier bin</caption>
          <thead className="text-slate-500 uppercase">
            <tr>
              <th scope="col" className="py-1 pr-3 font-medium">
                Bin (lower inclusive, upper exclusive)
              </th>
              <th scope="col" className="py-1 pr-3 text-right font-medium">
                Rounds
              </th>
              <th scope="col" className="py-1 text-right font-medium">
                Share of {formatCount(histogram.denominator)}
              </th>
            </tr>
          </thead>
          <tbody className="divide-y divide-slate-800 font-mono tabular-nums">
            {rows.map((row) => (
              <tr key={row.label}>
                <td className="py-1 pr-3">{row.label}</td>
                <td className="py-1 pr-3 text-right">{formatCount(row.count)}</td>
                <td className="py-1 text-right">{formatPercent(row.proportion)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </details>
    </figure>
  );
}
