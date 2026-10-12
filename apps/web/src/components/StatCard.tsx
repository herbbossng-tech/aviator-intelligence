export function StatCard({
  label,
  value,
  detail,
  muted = false,
}: {
  label: string;
  value: string;
  detail: string;
  /** Render the value de-emphasised, e.g. when nothing has been recorded yet. */
  muted?: boolean;
}) {
  return (
    <div className="rounded-lg border border-slate-800 bg-slate-900/40 p-5">
      <p className="text-xs font-medium tracking-wide text-slate-500 uppercase">{label}</p>
      <p
        className={`mt-2 font-mono text-2xl font-semibold tabular-nums ${muted ? 'text-slate-500' : 'text-slate-100'}`}
      >
        {value}
      </p>
      <p className="mt-1 text-xs text-slate-400">{detail}</p>
    </div>
  );
}
