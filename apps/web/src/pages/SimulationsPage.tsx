import { useState } from 'react';
import { Link } from 'react-router';
import { STOP_REASON_TEXT, type SimulationRunDto } from '@aviator/shared';
import { api } from '../api/client';
import { useApi } from '../api/useApi';
import { EmptyState } from '../components/EmptyState';
import { ErrorNotice } from '../components/ErrorNotice';
import { PageHeader } from '../components/PageHeader';
import { Pagination } from '../components/Pagination';
import { Panel } from '../components/Panel';
import { formatCount, formatMinorAmount, formatTimestamp } from '../lib/format';
import { formatPercent } from '../lib/stats';
import {
  BACKTEST_CAUTION,
  describeDatasetRequest,
  describeLegs,
  formatSignedMinor,
  signedPercent,
} from './simulations/display';

const PAGE_SIZE = 20;
const MAX_COMPARE = 4;

export function SimulationsPage() {
  const [offset, setOffset] = useState(0);
  const [selected, setSelected] = useState<SimulationRunDto[]>([]);
  const runs = useApi((signal) => api.simulations(PAGE_SIZE, offset, signal), [offset]);

  const toggle = (run: SimulationRunDto) =>
    setSelected((s) =>
      s.some((r) => r.id === run.id)
        ? s.filter((r) => r.id !== run.id)
        : s.length < MAX_COMPARE
          ? [...s, run]
          : s,
    );

  return (
    <>
      <PageHeader
        title="Simulations"
        description="Stored virtual backtests. Each run keeps its configuration, dataset, summary and full ledger."
      >
        <Link
          to="/strategy-lab"
          className="rounded-md bg-sky-600 px-4 py-2 text-sm font-medium text-white hover:bg-sky-500"
        >
          New backtest
        </Link>
      </PageHeader>

      <div
        role="note"
        className="mb-6 rounded-md border border-amber-400/30 bg-amber-400/5 px-4 py-3 text-sm text-amber-200"
      >
        {BACKTEST_CAUTION}
      </div>

      {selected.length >= 2 ? <Comparison runs={selected} onClear={() => setSelected([])} /> : null}

      <Panel
        title="Simulation runs"
        subtitle={`Newest first. Select 2–${MAX_COMPARE} completed runs to compare them.`}
      >
        {runs.status === 'loading' ? <p className="text-sm text-slate-400">Loading runs…</p> : null}
        {runs.status === 'error' ? <ErrorNotice message={runs.message} /> : null}
        {runs.status === 'success' && runs.data.total === 0 ? (
          <EmptyState title="No simulations run yet">
            Configure legs and a dataset in the{' '}
            <Link to="/strategy-lab" className="text-sky-400 hover:text-sky-300">
              strategy lab
            </Link>{' '}
            to run the first backtest. No example results are shown.
          </EmptyState>
        ) : null}
        {runs.status === 'success' && runs.data.total > 0 ? (
          <>
            <div className="overflow-x-auto">
              <table className="w-full min-w-[56rem] text-left text-sm">
                <caption className="sr-only">Simulation runs</caption>
                <thead className="text-xs text-slate-500 uppercase">
                  <tr>
                    <th scope="col" className="py-2 pr-3 font-medium">
                      <span className="sr-only">Compare</span>
                    </th>
                    <th scope="col" className="py-2 pr-4 font-medium">
                      Run
                    </th>
                    <th scope="col" className="py-2 pr-4 font-medium">
                      Status
                    </th>
                    <th scope="col" className="py-2 pr-4 font-medium">
                      Legs
                    </th>
                    <th scope="col" className="py-2 pr-4 font-medium">
                      Dataset
                    </th>
                    <th scope="col" className="py-2 pr-4 text-right font-medium">
                      Rounds
                    </th>
                    <th scope="col" className="py-2 pr-4 text-right font-medium">
                      Net
                    </th>
                    <th scope="col" className="py-2 pr-4 text-right font-medium">
                      Max drawdown (% of peak)
                    </th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-slate-800">
                  {runs.data.items.map((run) => (
                    <tr key={run.id}>
                      <td className="py-2 pr-3">
                        {run.status === 'completed' ? (
                          <input
                            type="checkbox"
                            aria-label={`Compare run #${run.id}`}
                            checked={selected.some((r) => r.id === run.id)}
                            disabled={
                              !selected.some((r) => r.id === run.id) &&
                              selected.length >= MAX_COMPARE
                            }
                            onChange={() => toggle(run)}
                          />
                        ) : null}
                      </td>
                      <td className="py-2 pr-4">
                        <Link
                          to={`/simulations/${run.id}`}
                          className="font-medium text-sky-400 hover:text-sky-300"
                        >
                          #{run.id}
                        </Link>
                        <div className="text-xs text-slate-500">
                          {formatTimestamp(run.createdAt)}
                        </div>
                      </td>
                      <td className="py-2 pr-4">
                        {run.status === 'completed' ? (
                          <span className="text-emerald-300">Completed</span>
                        ) : (
                          <span className="text-rose-300">Failed</span>
                        )}
                      </td>
                      <td className="py-2 pr-4 font-mono text-xs text-slate-300">
                        {describeLegs(run)}
                      </td>
                      <td className="py-2 pr-4 text-xs break-all text-slate-400">
                        {describeDatasetRequest(run.datasetRequest)}
                      </td>
                      <td className="py-2 pr-4 text-right font-mono whitespace-nowrap tabular-nums">
                        {run.summary ? formatCount(run.summary.roundsReplayed) : '—'}
                      </td>
                      <td className="py-2 pr-4 text-right font-mono whitespace-nowrap tabular-nums">
                        {run.summary
                          ? formatSignedMinor(run.summary.netProfitMinor, run.summary.currency)
                          : '—'}
                      </td>
                      <td className="py-2 pr-4 text-right font-mono whitespace-nowrap tabular-nums">
                        {run.summary ? formatPercent(run.summary.maxDrawdownFraction) : '—'}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
            <Pagination
              label="Simulation runs pages"
              offset={offset}
              limit={PAGE_SIZE}
              shown={runs.data.items.length}
              total={runs.data.total}
              onChange={setOffset}
            />
          </>
        ) : null}
      </Panel>
    </>
  );
}

function Comparison({ runs, onClear }: { runs: SimulationRunDto[]; onClear: () => void }) {
  const metrics: [string, (r: SimulationRunDto) => string][] = [
    ['Legs', describeLegs],
    ['Dataset', (r) => describeDatasetRequest(r.datasetRequest)],
    ['Dataset SHA-256', (r) => (r.datasetSha256 ? `${r.datasetSha256.slice(0, 12)}…` : '—')],
    [
      'Rounds replayed',
      (r) =>
        r.summary
          ? `${formatCount(r.summary.roundsReplayed)} of ${formatCount(r.summary.roundsAvailable)}`
          : '—',
    ],
    ['Stop reason', (r) => (r.summary ? STOP_REASON_TEXT[r.summary.stopReason] : '—')],
    [
      'Starting bankroll',
      (r) =>
        r.summary ? formatMinorAmount(r.summary.startingBankrollMinor, r.summary.currency) : '—',
    ],
    [
      'Ending bankroll',
      (r) =>
        r.summary ? formatMinorAmount(r.summary.endingBankrollMinor, r.summary.currency) : '—',
    ],
    [
      'Total staked',
      (r) => (r.summary ? formatMinorAmount(r.summary.totalStakedMinor, r.summary.currency) : '—'),
    ],
    [
      'Total returned (gross)',
      (r) =>
        r.summary ? formatMinorAmount(r.summary.totalReturnedMinor, r.summary.currency) : '—',
    ],
    [
      'Net (returned − staked)',
      (r) => (r.summary ? formatSignedMinor(r.summary.netProfitMinor, r.summary.currency) : '—'),
    ],
    [
      'Return on starting bankroll',
      (r) => (r.summary ? signedPercent(r.summary.returnOnStartingBankroll) : '—'),
    ],
    [
      'Max drawdown (amount)',
      (r) => (r.summary ? formatMinorAmount(r.summary.maxDrawdownMinor, r.summary.currency) : '—'),
    ],
    [
      'Max drawdown (% of running peak)',
      (r) => (r.summary ? formatPercent(r.summary.maxDrawdownFraction) : '—'),
    ],
    [
      'Lowest bankroll',
      (r) =>
        r.summary ? formatMinorAmount(r.summary.lowestBankrollMinor, r.summary.currency) : '—',
    ],
    [
      'Longest losing streak',
      (r) => (r.summary ? `${formatCount(r.summary.longestLosingStreak)} round(s)` : '—'),
    ],
  ];
  return (
    <div className="mb-6">
      <Panel
        title="Comparison"
        subtitle="Runs over different datasets are not directly comparable; check the dataset rows"
        actions={
          <button
            type="button"
            onClick={onClear}
            className="rounded px-3 py-1.5 text-xs text-slate-300 ring-1 ring-slate-700 hover:bg-slate-800"
          >
            Clear selection
          </button>
        }
      >
        <div className="overflow-x-auto">
          <table className="w-full min-w-[40rem] text-left text-sm">
            <caption className="sr-only">Comparison of selected simulation runs</caption>
            <thead className="text-xs text-slate-500 uppercase">
              <tr>
                <th scope="col" className="py-2 pr-4 font-medium">
                  Metric
                </th>
                {runs.map((r) => (
                  <th key={r.id} scope="col" className="py-2 pr-4 font-medium">
                    Run #{r.id}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody className="divide-y divide-slate-800">
              {metrics.map(([label, value]) => (
                <tr key={label}>
                  <th scope="row" className="py-2 pr-4 font-normal text-slate-400">
                    {label}
                  </th>
                  {runs.map((r) => (
                    <td
                      key={r.id}
                      className="py-2 pr-4 font-mono text-xs break-words text-slate-200"
                    >
                      {value(r)}
                    </td>
                  ))}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </Panel>
    </div>
  );
}
