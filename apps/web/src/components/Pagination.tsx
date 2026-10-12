import { formatCount } from '../lib/format';

export function Pagination({
  offset,
  limit,
  shown,
  total,
  onChange,
  label,
}: {
  offset: number;
  limit: number;
  shown: number;
  total: number;
  onChange: (offset: number) => void;
  label: string;
}) {
  if (total === 0) return null;
  return (
    <nav
      aria-label={label}
      className="mt-4 flex flex-wrap items-center justify-between gap-2 text-xs text-slate-400"
    >
      <span>
        Showing {formatCount(offset + 1)}–{formatCount(offset + shown)} of {formatCount(total)}
      </span>
      <div className="flex gap-2">
        <button
          type="button"
          className="rounded px-3 py-1.5 ring-1 ring-slate-700 hover:bg-slate-800 disabled:opacity-40"
          disabled={offset === 0}
          onClick={() => onChange(Math.max(0, offset - limit))}
        >
          Previous
        </button>
        <button
          type="button"
          className="rounded px-3 py-1.5 ring-1 ring-slate-700 hover:bg-slate-800 disabled:opacity-40"
          disabled={offset + limit >= total}
          onClick={() => onChange(offset + limit)}
        >
          Next
        </button>
      </div>
    </nav>
  );
}
