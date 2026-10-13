import { useState } from 'react';
import { Link, useParams } from 'react-router';
import { STOP_REASON_TEXT, type LedgerResponse, type SimulationRunDto } from '@aviator/shared';

type LedgerLeg = LedgerResponse['rounds'][number]['legs'][number];
import { api } from '../../api/client';
import { useApi } from '../../api/useApi';
import { ErrorNotice } from '../../components/ErrorNotice';
import { PageHeader } from '../../components/PageHeader';
import { Pagination } from '../../components/Pagination';
import { Panel } from '../../components/Panel';
import { StatCard } from '../../components/StatCard';
import {
  formatCount,
  formatMinorAmount,
  formatMultiplierX100,
  formatTimestamp,
} from '../../lib/format';
import { formatPercent } from '../../lib/stats';
import {
  AssumptionsList,
  BACKTEST_CAUTION,
  DatasetReportView,
  describeDatasetRequest,
  describeProgression,
  formatSignedMinor,
  PROGRESSION_CAUTION,
  signedPercent,
  SKIP_REASON_TEXT,
} from './display';

const LEDGER_PAGE = 50;

export function SimulationDetailPage() {
  const { id } = useParams();
  const runId = /^\d{1,15}$/.test(id ?? '') ? Number(id) : null;
  const run = useApi(
    (signal) =>
      runId === null
        ? Promise.reject(new Error('No such simulation run.'))
        : api.simulation(runId, signal),
    [runId],
  );

  return (
    <>
      <PageHeader
        title={runId === null ? 'Simulation run' : `Simulation run #${runId}`}
        description="Configuration, dataset, results and ledger of one virtual backtest."
      >
        <Link to="/simulations" className="text-sm text-sky-400 hover:text-sky-300">
          ← All runs
        </Link>
      </PageHeader>
      {run.status === 'loading' ? <p className="text-sm text-slate-400">Loading run…</p> : null}
      {run.status === 'error' ? <ErrorNotice message={run.message} /> : null}
      {run.status === 'success' ? <RunView run={run.data} /> : null}
    </>
  );
}

function RunView({ run }: { run: SimulationRunDto }) {
  const { summary } = run;
  const currency = run.settings.currency;
  const money = (v: number) => formatMinorAmount(v, currency);
  return (
    <div className="space-y-6">
      <div
        role="note"
        className="rounded-md border border-amber-400/30 bg-amber-400/5 px-4 py-3 text-sm text-amber-200"
      >
        {BACKTEST_CAUTION}
        {run.staking === null ? null : <p className="mt-2">{PROGRESSION_CAUTION}</p>}
      </div>

      {run.status === 'failed' || summary === null ? (
        <ErrorNotice
          message={`This run failed and has no results or ledger. ${run.errorMessage ?? ''}`.trim()}
        />
      ) : (
        <>
          <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-4">
            <StatCard
              label="Ending bankroll"
              value={money(summary.endingBankrollMinor)}
              detail={`Started at ${money(summary.startingBankrollMinor)} · virtual funds`}
            />
            <StatCard
              label="Net (returned − staked)"
              value={formatSignedMinor(summary.netProfitMinor, currency)}
              detail={`${signedPercent(summary.returnOnStartingBankroll)} of the starting bankroll`}
            />
            <StatCard
              label="Staked / returned"
              value={money(summary.totalStakedMinor)}
              detail={`Returned (gross, incl. stakes): ${money(summary.totalReturnedMinor)}`}
            />
            <StatCard
              label="Rounds replayed"
              value={formatCount(summary.roundsReplayed)}
              detail={`of ${formatCount(summary.roundsAvailable)} eligible · ${STOP_REASON_TEXT[summary.stopReason]}`}
            />
            <StatCard
              label="Max drawdown"
              value={money(summary.maxDrawdownMinor)}
              detail={`Largest fall from a running peak · largest relative fall ${formatPercent(summary.maxDrawdownFraction)} · peak ${money(summary.peakBankrollMinor)}`}
            />
            <StatCard
              label="Lowest bankroll"
              value={money(summary.lowestBankrollMinor)}
              detail="Lowest end-of-round bankroll, including the start"
            />
            <StatCard
              label="Longest losing streak"
              value={`${formatCount(summary.longestLosingStreak)}`}
              detail="Consecutive rounds with a negative net"
            />
            <StatCard
              label="Rounds with a profit"
              value={formatPercent(summary.profitableRoundShare)}
              detail={`${formatCount(summary.roundsWithProfit)} of ${formatCount(summary.roundsReplayed)} replayed · ${formatCount(summary.roundsWithLoss)} loss · ${formatCount(summary.roundsBreakEven)} break-even`}
            />
          </div>

          <Panel
            title="Uncertainty and robustness"
            subtitle="How sensitive is this result to the particular historical sequence?"
          >
            {run.staking !== null ? (
              <p className="text-sm text-slate-400">
                Not available for this run: uncertainty and robustness analyses currently support
                flat-stake runs only, and this run uses a staking progression.
              </p>
            ) : (
              <>
                <p className="text-sm text-slate-400">
                  Resample this run&apos;s {formatCount(run.dataset?.roundsEligible ?? 0)} observed
                  multipliers (IID bootstrap) and replay the same configuration on many resampled
                  paths, or replay separate chronological periods of the same data one at a time.
                  Sensitivity checks under stated assumptions, not predictions.
                </p>
                <div className="mt-3 flex flex-wrap gap-2">
                  <Link
                    to={`/simulations/${run.id}/uncertainty`}
                    className="inline-block rounded-md bg-slate-800 px-3 py-2 text-sm text-slate-200 ring-1 ring-slate-700 hover:bg-slate-700"
                  >
                    Open uncertainty analysis
                  </Link>
                  <Link
                    to={`/simulations/${run.id}/robustness`}
                    className="inline-block rounded-md bg-slate-800 px-3 py-2 text-sm text-slate-200 ring-1 ring-slate-700 hover:bg-slate-700"
                  >
                    Open robustness analysis
                  </Link>
                </div>
              </>
            )}
          </Panel>

          {summary.progression && run.staking ? (
            <ProgressionSummaryPanel run={run} progression={summary.progression} />
          ) : null}

          <Panel
            title="Per leg"
            subtitle={
              run.staking === null
                ? 'Win rate denominators are placed bets'
                : 'Win rate denominators are placed bets; for a progression leg, Stake is its base stake'
            }
          >
            <div className="overflow-x-auto">
              <table className="w-full min-w-[44rem] text-left text-sm">
                <caption className="sr-only">Results per leg</caption>
                <thead className="text-xs text-slate-500 uppercase">
                  <tr>
                    <th scope="col" className="py-2 pr-4 font-medium">
                      Leg
                    </th>
                    <th scope="col" className="py-2 pr-4 text-right font-medium">
                      Target
                    </th>
                    <th scope="col" className="py-2 pr-4 text-right font-medium">
                      Stake
                    </th>
                    <th scope="col" className="py-2 pr-4 text-right font-medium">
                      Wins / losses
                    </th>
                    <th scope="col" className="py-2 pr-4 text-right font-medium">
                      Win rate
                    </th>
                    <th scope="col" className="py-2 pr-4 text-right font-medium">
                      Skipped
                    </th>
                    <th scope="col" className="py-2 pr-4 text-right font-medium">
                      Staked
                    </th>
                    <th scope="col" className="py-2 pr-4 text-right font-medium">
                      Returned
                    </th>
                    <th scope="col" className="py-2 pr-4 text-right font-medium">
                      Net
                    </th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-slate-800 font-mono tabular-nums">
                  {summary.legs.map((leg) => (
                    <tr key={leg.leg}>
                      <th scope="row" className="py-2 pr-4 font-sans font-normal text-slate-300">
                        {leg.leg} · {leg.label}
                        {leg.enabled ? '' : ' (disabled)'}
                      </th>
                      <td className="py-2 pr-4 text-right">
                        {formatMultiplierX100(leg.cashoutTargetX100)}
                      </td>
                      <td className="py-2 pr-4 text-right">{money(leg.stakeMinor)}</td>
                      <td className="py-2 pr-4 text-right">
                        {formatCount(leg.wins)} / {formatCount(leg.losses)}
                      </td>
                      <td className="py-2 pr-4 text-right">
                        {leg.targetReachedShare === null
                          ? '—'
                          : `${formatPercent(leg.targetReachedShare)} of ${formatCount(leg.placed)}`}
                      </td>
                      <td className="py-2 pr-4 text-right">{formatCount(leg.skipped)}</td>
                      <td className="py-2 pr-4 text-right">{money(leg.stakedMinor)}</td>
                      <td className="py-2 pr-4 text-right">{money(leg.grossReturnMinor)}</td>
                      <td className="py-2 pr-4 text-right">
                        {formatSignedMinor(leg.netMinor, currency)}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </Panel>

          <Ledger run={run} />
        </>
      )}

      <div className="grid gap-6 lg:grid-cols-2">
        <Panel title="Configuration" subtitle="Exactly as stored with the run">
          <dl className="grid gap-x-6 gap-y-2 text-sm sm:grid-cols-[minmax(0,12rem)_minmax(0,1fr)]">
            {(['A', 'B'] as const).map((k) => {
              const leg = run.strategy.legs[k];
              return (
                <div key={k} className="contents">
                  <dt className="text-slate-500">Leg {k}</dt>
                  <dd className="text-slate-200">
                    {leg.enabled
                      ? `${money(leg.stakeMinor)} at ${formatMultiplierX100(leg.cashoutTargetX100)} (“${leg.label}”)`
                      : `Disabled (“${leg.label}”)`}
                  </dd>
                  <dt className="text-slate-500">Leg {k} staking</dt>
                  <dd className="text-slate-200">
                    {progressionOf(run, k)
                      ? describeProgression(progressionOf(run, k)!, currency)
                      : 'Flat (same stake every round)'}
                  </dd>
                </div>
              );
            })}
            <dt className="text-slate-500">Starting bankroll</dt>
            <dd className="text-slate-200">{money(run.settings.startingBankrollMinor)}</dd>
            <dt className="text-slate-500">Insufficient bankroll</dt>
            <dd className="text-slate-200">
              {run.settings.insufficientBankrollPolicy === 'skip_leg'
                ? 'Skip the leg for that round'
                : 'Stop the run'}
            </dd>
            <dt className="text-slate-500">Stops</dt>
            <dd className="text-slate-200">{describeStops(run)}</dd>
            <dt className="text-slate-500">Created</dt>
            <dd className="text-slate-200">{formatTimestamp(run.createdAt)}</dd>
          </dl>
        </Panel>
        <Panel title="Dataset and reproducibility">
          {run.dataset ? (
            <DatasetReportView report={run.dataset} />
          ) : (
            <p className="text-sm text-slate-400">
              Requested: {describeDatasetRequest(run.datasetRequest)}. The selection was not
              resolved before the run failed.
            </p>
          )}
          {run.datasetSha256 ? (
            <p className="mt-4 text-xs break-all text-slate-500">
              SHA-256 of the dataset's eligible rounds in replay order (source, then each round's
              id, source id, multiplier and event time), whether or not the replay reached them:{' '}
              <span className="font-mono text-slate-300">{run.datasetSha256}</span>. Re-running the
              same configuration on the same rounds gives the same hash and results.
            </p>
          ) : null}
        </Panel>
      </div>

      <Panel title="Assumptions">
        <AssumptionsList />
      </Panel>
    </div>
  );
}

function progressionOf(run: SimulationRunDto, leg: 'A' | 'B') {
  return run.staking?.legs[leg] ?? null;
}

const FINAL_STATUS_TEXT = {
  active: 'Still active at the end',
  blocked: 'Stopped by a limit',
  exhausted: 'Sequence exhausted',
} as const;

function ProgressionSummaryPanel({
  run,
  progression,
}: {
  run: SimulationRunDto;
  progression: NonNullable<NonNullable<SimulationRunDto['summary']>['progression']>;
}) {
  const currency = run.settings.currency;
  const money = (v: number) => formatMinorAmount(v, currency);
  return (
    <Panel
      title="Staking progression"
      subtitle="Each leg progresses from its own results only; virtual stakes"
    >
      <div className="grid gap-6 md:grid-cols-2">
        {(['A', 'B'] as const).map((k) => {
          const leg = progression.legs[k];
          const config = progressionOf(run, k);
          if (leg === null || config === null) {
            return (
              <div key={k} className="text-sm text-slate-400">
                <h3 className="mb-2 font-medium text-slate-200">Leg {k}</h3>
                Flat stakes (no progression).
              </div>
            );
          }
          const rows: [string, string][] = [
            ['Configuration', describeProgression(config, currency)],
            [
              'Final state',
              leg.finalBlockReason === null
                ? FINAL_STATUS_TEXT[leg.finalStatus]
                : `${FINAL_STATUS_TEXT[leg.finalStatus]}: ${SKIP_REASON_TEXT[leg.finalBlockReason]}`,
            ],
            [
              'Stopped from round',
              leg.inactiveFromSequenceNo === null
                ? '—'
                : `#${formatCount(leg.inactiveFromSequenceNo + 1)}`,
            ],
            ['Step at the end (0 = base)', formatCount(leg.finalStep)],
            [
              'Highest step placed',
              leg.maxStepPlaced === null ? '—' : formatCount(leg.maxStepPlaced),
            ],
            ['Open cycle loss at the end', money(leg.finalCycleLossMinor)],
            ['Cycles completed (won)', formatCount(leg.cyclesCompleted)],
            ['Skipped: bankroll could not fund', formatCount(leg.skippedInsufficientBankroll)],
            ['Skipped: leg stopped by a limit', formatCount(leg.skippedInactive)],
            ['Configuration key', leg.configKey],
          ];
          return (
            <div key={k}>
              <h3 className="mb-2 text-sm font-medium text-slate-200">Leg {k}</h3>
              <dl className="grid gap-x-4 gap-y-1 text-sm sm:grid-cols-[minmax(0,13rem)_minmax(0,1fr)]">
                {rows.map(([label, value]) => (
                  <div key={label} className="contents">
                    <dt className="text-slate-500">{label}</dt>
                    <dd className="break-words text-slate-200">{value}</dd>
                  </div>
                ))}
              </dl>
            </div>
          );
        })}
      </div>
      {progression.roundsWithoutStake > 0 ? (
        <p className="mt-4 text-sm text-slate-400">
          {formatCount(progression.roundsWithoutStake)} round(s) were replayed after every
          progression leg had stopped, so nothing was staked in them.
        </p>
      ) : null}
    </Panel>
  );
}

function describeStops(run: SimulationRunDto): string {
  const { risk, currency } = run.settings;
  const parts: string[] = [];
  if (risk.stopBelowBankrollMinor !== null)
    parts.push(`below ${formatMinorAmount(risk.stopBelowBankrollMinor, currency)}`);
  if (risk.stopAtOrAboveBankrollMinor !== null)
    parts.push(`at or above ${formatMinorAmount(risk.stopAtOrAboveBankrollMinor, currency)}`);
  if (risk.maxDrawdownBps !== null)
    parts.push(`drawdown ≥ ${(risk.maxDrawdownBps / 100).toFixed(2)}%`);
  if (risk.maxRounds !== null) parts.push(`after ${formatCount(risk.maxRounds)} rounds`);
  return parts.length === 0 ? 'None' : parts.join(' · ');
}

/** Progression detail for one ledger leg; the requested stake is never shown as placed. */
function describeLedgerProgression(
  p: NonNullable<LedgerLeg['progression']>,
  money: (v: number) => string,
): string {
  const parts = [`step ${p.step}`];
  if (p.skipReason !== null) {
    if (p.requestedStakeMinor !== null) parts.push(`requested ${money(p.requestedStakeMinor)}`);
    parts.push(SKIP_REASON_TEXT[p.skipReason]);
  }
  parts.push(`cycle loss ${money(p.cycleLossBeforeMinor)} → ${money(p.cycleLossAfterMinor)}`);
  return ` · ${parts.join(' · ')}`;
}

const RESULT_TEXT = { win: 'Target reached', loss: 'Lost', skipped: 'Skipped' } as const;

function Ledger({ run }: { run: SimulationRunDto }) {
  const [offset, setOffset] = useState(0);
  const ledger = useApi(
    (signal) => api.simulationLedger(run.id, LEDGER_PAGE, offset, signal),
    [run.id, offset],
  );
  const money = (v: number) => formatMinorAmount(v, run.settings.currency);
  return (
    <Panel title="Virtual ledger" subtitle="Every replayed round, in replay order">
      {ledger.status === 'loading' ? (
        <p className="text-sm text-slate-400">Loading ledger…</p>
      ) : null}
      {ledger.status === 'error' ? <ErrorNotice message={ledger.message} /> : null}
      {ledger.status === 'success' && ledger.data.totalRounds === 0 ? (
        <p className="text-sm text-slate-400">No rounds were replayed in this run.</p>
      ) : null}
      {ledger.status === 'success' && ledger.data.totalRounds > 0 ? (
        <>
          <div className="overflow-x-auto">
            <table className="w-full min-w-[52rem] text-left text-sm">
              <caption className="sr-only">Virtual ledger</caption>
              <thead className="text-xs text-slate-500 uppercase">
                <tr>
                  <th scope="col" className="py-2 pr-4 font-medium">
                    #
                  </th>
                  <th scope="col" className="py-2 pr-4 font-medium">
                    Event time
                  </th>
                  <th scope="col" className="py-2 pr-4 text-right font-medium">
                    Multiplier
                  </th>
                  <th scope="col" className="py-2 pr-4 font-medium">
                    Legs
                  </th>
                  <th scope="col" className="py-2 pr-4 text-right font-medium">
                    Round net
                  </th>
                  <th scope="col" className="py-2 pr-4 text-right font-medium">
                    Bankroll after
                  </th>
                </tr>
              </thead>
              <tbody className="divide-y divide-slate-800">
                {ledger.data.rounds.map((r) => (
                  <tr key={r.sequenceNo}>
                    <td className="py-2 pr-4 font-mono text-slate-500">{r.sequenceNo + 1}</td>
                    <td className="py-2 pr-4 whitespace-nowrap text-slate-300">
                      {formatTimestamp(r.eventAt)}
                    </td>
                    <td className="py-2 pr-4 text-right font-mono whitespace-nowrap tabular-nums">
                      {formatMultiplierX100(r.multiplierX100)}
                    </td>
                    <td className="py-2 pr-4 text-xs text-slate-300">
                      {r.legs.map((l) => (
                        <div key={l.leg}>
                          {l.leg} {formatMultiplierX100(l.cashoutTargetX100)}:{' '}
                          {RESULT_TEXT[l.result]}
                          {l.result === 'skipped'
                            ? ''
                            : ` · staked ${money(l.stakeMinor)} · returned ${money(l.grossReturnMinor)}`}
                          {l.progression ? describeLedgerProgression(l.progression, money) : ''}
                        </div>
                      ))}
                    </td>
                    <td className="py-2 pr-4 text-right font-mono whitespace-nowrap tabular-nums">
                      {formatSignedMinor(r.roundNetMinor, run.settings.currency)}
                    </td>
                    <td className="py-2 pr-4 text-right font-mono whitespace-nowrap tabular-nums">
                      {money(r.bankrollAfterMinor)}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          <Pagination
            label="Ledger pages"
            offset={offset}
            limit={LEDGER_PAGE}
            shown={ledger.data.rounds.length}
            total={ledger.data.totalRounds}
            onChange={setOffset}
          />
        </>
      ) : null}
    </Panel>
  );
}
