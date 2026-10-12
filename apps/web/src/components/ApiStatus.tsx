import { api } from '../api/client';
import { useApi } from '../api/useApi';

/** Reports whether the LOCAL API and database are reachable. This is not a live game feed. */
export function ApiStatus() {
  const health = useApi((signal) => api.health(signal));

  let dot = 'bg-slate-500';
  let label = 'Checking local API…';
  if (health.status === 'error') {
    dot = 'bg-rose-500';
    label = 'Local API unreachable';
  } else if (health.status === 'success') {
    const ok = health.data.status === 'ok';
    dot = ok ? 'bg-emerald-500' : 'bg-amber-500';
    label = ok
      ? `Local API ok · schema v${health.data.database.schemaVersion ?? '?'}`
      : 'Local API degraded (database)';
  }

  return (
    <div
      className="flex items-center gap-2 text-xs text-slate-400"
      title="Status of the local API on this machine"
    >
      <span aria-hidden="true" className={`h-2 w-2 rounded-full ${dot}`} />
      <span>{label}</span>
    </div>
  );
}
