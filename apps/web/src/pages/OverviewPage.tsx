import { Link } from 'react-router';
import type { OverviewResponse, RoundsListResponse } from '@aviator/shared';
import { api } from '../api/client';
import { useApi } from '../api/useApi';
import { EmptyState } from '../components/EmptyState';
import { ErrorNotice } from '../components/ErrorNotice';
import { PageHeader } from '../components/PageHeader';
import { Panel } from '../components/Panel';
import { PlannedBadge } from '../components/PlannedBadge';
import { RoundsTable } from '../components/RoundsTable';
import { StatCard } from '../components/StatCard';
import { formatCount, formatMinorAmount, formatTimestamp } from '../lib/format';

const RECENT_ROUNDS_LIMIT = 10;

export function OverviewPage() {
  const overview = useApi((signal) => api.overview(signal));
  const recent = useApi((signal) => api.rounds({ limit: RECENT_ROUNDS_LIMIT, offset: 0 }, signal));

  return (
    <>
      <PageHeader
        title="Overview"
        description="A summary of the round data and virtual simulations stored on this machine. Figures describe recorded history only and are not forecasts."
      />

      {overview.status === 'error' ? <ErrorNotice message={overview.message} /> : null}
      {overview.status === 'loading' ? (
        <p className="text-sm text-slate-500">Loading overview…</p>
      ) : null}
      {overview.status === 'success' ? <SummaryCards data={overview.data} /> : null}

      <div className="mt-6 grid gap-6 xl:grid-cols-[2fr_1fr]">
        <Panel
          title="Recent rounds"
          subtitle={`Latest ${RECENT_ROUNDS_LIMIT} recorded rounds, most recently stored first`}
          actions={
            <Link to="/rounds" className="text-xs text-sky-400 hover:text-sky-300">
              View all
            </Link>
          }
        >
          <RecentRounds state={recent} />
        </Panel>

        <div className="flex flex-col gap-6">
          <Panel
            title="Strategy lab"
            subtitle="Two-leg virtual configurations"
            actions={<PlannedBadge>Preview</PlannedBadge>}
          >
            <p className="text-sm text-slate-400">
              Define two independently configured simulated legs (for example, different cashout
              targets) and, in a later phase, compare them against recorded history.
            </p>
            <Link
              to="/strategy-lab"
              className="mt-4 inline-block rounded-md bg-slate-800 px-3 py-2 text-sm text-slate-200 ring-1 ring-slate-700 hover:bg-slate-700"
            >
              Open strategy lab
            </Link>
          </Panel>

          <Panel title="Live data" subtitle="Real-time round observation">
            <p className="text-sm text-slate-400">
              <span className="font-medium text-slate-300">Not connected.</span> No live data source
              is implemented. Any future integration requires a documented, permitted data-access
              method.
            </p>
          </Panel>
        </div>
      </div>
    </>
  );
}

function SummaryCards({ data }: { data: OverviewResponse }) {
  const { rounds, imports, simulations, latestVirtualBankroll } = data;
  return (
    <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-4">
      <StatCard
        label="Historical rounds"
        value={formatCount(rounds.total)}
        muted={rounds.total === 0}
        detail={
          rounds.total === 0
            ? 'No rounds recorded yet'
            : `${formatCount(rounds.distinctSources)} source(s) · latest ${formatTimestamp(rounds.latestObservedAt)}`
        }
      />
      <StatCard
        label="Simulation runs"
        value={formatCount(simulations.total)}
        muted={simulations.total === 0}
        detail={
          simulations.total === 0
            ? 'No simulations run yet (engine not yet implemented)'
            : `${formatCount(simulations.completed)} completed`
        }
      />
      <StatCard
        label="Virtual bankroll"
        value={
          latestVirtualBankroll
            ? formatMinorAmount(
                latestVirtualBankroll.endingBankrollMinor,
                latestVirtualBankroll.currency,
              )
            : '—'
        }
        muted={latestVirtualBankroll === null}
        detail={
          latestVirtualBankroll
            ? `Latest completed run #${latestVirtualBankroll.simulationRunId} · virtual funds`
            : 'No completed simulation yet · virtual funds only'
        }
      />
      <StatCard
        label="Data quality"
        value={imports.total === 0 ? '—' : `${formatCount(imports.recordsRejected)} rejected`}
        muted={imports.total === 0}
        detail={
          imports.total === 0
            ? 'No imports yet'
            : `${formatCount(imports.total)} import(s) · ${formatCount(imports.recordsAccepted)} stored · ${formatCount(imports.recordsDuplicate)} duplicate(s) skipped · ${formatCount(imports.failed)} failed`
        }
      />
    </div>
  );
}

function RecentRounds({ state }: { state: ReturnType<typeof useApi<RoundsListResponse>> }) {
  if (state.status === 'loading') return <p className="text-sm text-slate-500">Loading rounds…</p>;
  if (state.status === 'error') return <ErrorNotice message={state.message} />;
  if (state.data.items.length === 0) {
    return (
      <EmptyState title="No rounds recorded yet">
        Round history appears here once you{' '}
        <Link className="text-sky-400" to="/rounds/new">
          enter a round manually
        </Link>{' '}
        or{' '}
        <Link className="text-sky-400" to="/rounds/import">
          import a file
        </Link>{' '}
        from a documented, permitted source.
      </EmptyState>
    );
  }
  return <RoundsTable rounds={state.data.items} />;
}
