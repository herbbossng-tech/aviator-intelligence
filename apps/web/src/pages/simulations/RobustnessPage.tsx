import { useState, type FormEvent, type ReactNode } from 'react';
import { Link, useParams } from 'react-router';
import {
  MIN_ROBUSTNESS_WINDOWS,
  MIN_ROUNDS_PER_WINDOW,
  STOP_REASON_TEXT,
  type BacktestSummary,
  type RobustnessAnalysesList,
  type RobustnessAnalysisDto,
  type SimulationRunDto,
} from '@aviator/shared';
import { api, ApiRequestError } from '../../api/client';
import { useApi } from '../../api/useApi';
import { EmptyState } from '../../components/EmptyState';
import { ErrorNotice } from '../../components/ErrorNotice';
import { FormField, inputClass } from '../../components/FormField';
import { PageHeader } from '../../components/PageHeader';
import { Panel } from '../../components/Panel';
import { formatCount, formatMinorAmount, formatTimestamp } from '../../lib/format';
import { formatPercent } from '../../lib/stats';
import { formatSignedMinor, ROBUSTNESS_PROGRESSION_NOTE, SKIP_REASON_TEXT } from './display';

export const ROBUSTNESS_CAUTION =
  "Historical robustness analysis: each block replays one separate period of this run's own recorded rounds, starting again from the configured bankroll. Blocks are in-sample history, not out-of-sample validation. They are not predictions of future rounds and not evidence that a configuration is profitable.";

export function RobustnessPage() {
  const { id } = useParams();
  const runId = /^[1-9]\d{0,15}$/.test(id ?? '') ? Number(id) : null;
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
        title={runId === null ? 'Robustness analysis' : `Robustness analysis · run #${runId}`}
        description="Split the run's dataset into consecutive periods and replay the same configuration on each one separately, to see whether the historical result depends on one stretch of the data."
      >
        {runId !== null ? (
          <Link to={`/simulations/${runId}`} className="text-sm text-sky-400 hover:text-sky-300">
            ← Back to run #{runId}
          </Link>
        ) : null}
      </PageHeader>
      <div
        role="note"
        className="mb-6 rounded-md border border-amber-400/30 bg-amber-400/5 px-4 py-3 text-sm text-amber-200"
      >
        {ROBUSTNESS_CAUTION}
      </div>
      {run.status === 'loading' ? <p className="text-sm text-slate-400">Loading run…</p> : null}
      {run.status === 'error' ? <ErrorNotice message={run.message} /> : null}
      {run.status === 'success' ? (
        run.data.status !== 'completed' || run.data.summary === null ? (
          <ErrorNotice message="This run failed and has no results, so it cannot be analysed." />
        ) : (
          <Analyses run={run.data} />
        )
      ) : null}
    </>
  );
}

function Analyses({ run }: { run: SimulationRunDto }) {
  const [reload, setReload] = useState(0);
  const [selectedId, setSelectedId] = useState<number | null>(null);
  const list = useApi((signal) => api.robustnessAnalyses(run.id, signal), [run.id, reload]);
  // Keep the last loaded list on screen while a refresh is in flight.
  const [loaded, setLoaded] = useState<RobustnessAnalysesList>();
  if (list.status === 'success' && list.data !== loaded) setLoaded(list.data);
  const items = loaded?.items ?? [];
  // The analysis just created stays selected while the refreshed list loads.
  const [created, setCreated] = useState<RobustnessAnalysisDto | null>(null);
  const selected =
    items.find((a) => a.id === selectedId) ??
    (created !== null && created.id === selectedId ? created : null) ??
    items[0] ??
    null;

  return (
    <div className="space-y-6">
      <Dataset run={run} />
      {list.status === 'error' ? <ErrorNotice message={list.message} /> : null}
      {loaded ? (
        <RunForm
          run={run}
          maxWindows={loaded.maxWindows}
          onDone={(analysis) => {
            setCreated(analysis);
            setSelectedId(analysis.id);
            setReload((n) => n + 1);
          }}
        />
      ) : null}
      {list.status === 'loading' && !loaded ? (
        <p className="text-sm text-slate-400">Loading analyses…</p>
      ) : null}
      {loaded && items.length === 0 ? (
        <Panel title="Results">
          <EmptyState title="No robustness analysis yet">
            Run one above. No example results are shown.
          </EmptyState>
        </Panel>
      ) : null}
      {selected ? <Results run={run} analysis={selected} /> : null}
      {items.length > 1 ? (
        <Panel title="Saved analyses of this run" subtitle="Newest first">
          <div className="relative overflow-x-auto">
            <table className="w-full min-w-[32rem] text-left text-sm">
              <caption className="sr-only">Saved robustness analyses</caption>
              <thead className="text-xs text-slate-500 uppercase">
                <tr>
                  <th scope="col" className="py-2 pr-4 font-medium">
                    Analysis
                  </th>
                  <th scope="col" className="py-2 pr-4 font-medium">
                    Created
                  </th>
                  <th scope="col" className="py-2 pr-4 text-right font-medium">
                    Blocks
                  </th>
                  <th scope="col" className="py-2 pr-4 font-medium">
                    <span className="sr-only">Show</span>
                  </th>
                </tr>
              </thead>
              <tbody className="divide-y divide-slate-800">
                {items.map((a) => (
                  <tr key={a.id}>
                    <td className="py-2 pr-4">#{a.id}</td>
                    <td className="py-2 pr-4 text-slate-400">{formatTimestamp(a.createdAt)}</td>
                    <td className="py-2 pr-4 text-right font-mono">{a.windows}</td>
                    <td className="py-2 pr-4">
                      <button
                        type="button"
                        onClick={() => setSelectedId(a.id)}
                        aria-pressed={a.id === selected?.id}
                        className="rounded px-2 py-1 text-xs ring-1 ring-slate-700 hover:bg-slate-800 aria-pressed:bg-slate-800"
                      >
                        {a.id === selected?.id ? 'Showing' : `Show #${a.id}`}
                      </button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </Panel>
      ) : null}
    </div>
  );
}

function Rows({ rows }: { rows: [string, ReactNode][] }) {
  return (
    <dl className="grid gap-x-6 gap-y-2 text-sm sm:grid-cols-[minmax(0,14rem)_minmax(0,1fr)]">
      {rows.map(([label, value]) => (
        <div key={label} className="contents">
          <dt className="text-slate-500">{label}</dt>
          <dd className="break-words text-slate-200">{value}</dd>
        </div>
      ))}
    </dl>
  );
}

function Dataset({ run }: { run: SimulationRunDto }) {
  const report = run.dataset!;
  return (
    <div className="grid gap-6 lg:grid-cols-2">
      <Panel title="Dataset" subtitle="Every eligible round selected by this run's dataset">
        <Rows
          rows={[
            ['Source', report.dataset.source],
            ['Eligible rounds', formatCount(report.roundsEligible)],
            ['Excluded: no event time', formatCount(report.excludedNoEventTime)],
            ['Excluded: synthetic test fixtures', formatCount(report.excludedSynthetic)],
            [
              'Dataset fingerprint (SHA-256)',
              <span key="fp" className="font-mono text-xs break-all">
                {run.datasetSha256}
              </span>,
            ],
          ]}
        />
      </Panel>
      <Panel title="Method">
        <ul className="list-disc space-y-1.5 pl-5 text-sm text-slate-300">
          <li>
            The eligible rounds, in event-time order, are split into consecutive blocks of nearly
            equal size (at least {MIN_ROUNDS_PER_WINDOW} rounds each). Boundaries depend only on the
            round count, never on multipliers or results.
          </li>
          <li>
            Each block is replayed on its own with this run&apos;s exact configuration, starting
            again from the configured bankroll. Stops and the round limit apply within each block.
          </li>
          <li>
            Block results are independent replays: they are not added together and do not sum to the
            full-sample result, which carries the bankroll through the whole period.
          </li>
          {run.staking === null ? null : <li>{ROBUSTNESS_PROGRESSION_NOTE}</li>}
          <li>The server computes and verifies every result before saving it.</li>
        </ul>
      </Panel>
    </div>
  );
}

function RunForm({
  run,
  maxWindows,
  onDone,
}: {
  run: SimulationRunDto;
  maxWindows: number;
  onDone: (a: RobustnessAnalysisDto) => void;
}) {
  const choices = Array.from(
    { length: Math.max(0, maxWindows - MIN_ROBUSTNESS_WINDOWS + 1) },
    (_, i) => MIN_ROBUSTNESS_WINDOWS + i,
  );
  const [windows, setWindows] = useState(String(Math.min(3, maxWindows)));
  const [running, setRunning] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const submit = async (event: FormEvent) => {
    event.preventDefault();
    setError(null);
    setRunning(true);
    try {
      onDone(await api.runRobustness(run.id, { windows: Number(windows) }));
    } catch (e) {
      setError(e instanceof ApiRequestError || e instanceof Error ? e.message : 'Analysis failed.');
    } finally {
      setRunning(false);
    }
  };

  return (
    <Panel
      title="Run a robustness analysis"
      subtitle="Virtual money only; nothing is placed anywhere"
    >
      {maxWindows === 0 ? (
        <ErrorNotice
          message={`This run's sample has ${formatCount(run.dataset!.roundsEligible)} rounds; at least ${MIN_ROBUSTNESS_WINDOWS * MIN_ROUNDS_PER_WINDOW} are needed for ${MIN_ROBUSTNESS_WINDOWS} blocks of ${MIN_ROUNDS_PER_WINDOW}.`}
        />
      ) : (
        <form onSubmit={submit} noValidate aria-label="Robustness analysis settings">
          <div className="max-w-xs">
            <FormField
              id="windows"
              label="Chronological blocks"
              hint={`${MIN_ROBUSTNESS_WINDOWS} to ${maxWindows} for ${formatCount(run.dataset!.roundsEligible)} rounds`}
              required
            >
              {(p) => (
                <select
                  {...p}
                  className={inputClass}
                  value={windows}
                  onChange={(e) => setWindows(e.target.value)}
                >
                  {choices.map((w) => (
                    <option key={w} value={w}>
                      {w} blocks
                    </option>
                  ))}
                </select>
              )}
            </FormField>
          </div>
          <div className="mt-4 space-y-3" aria-live="polite">
            {error ? <ErrorNotice message={error} /> : null}
            <button
              type="submit"
              disabled={running}
              className="rounded-md bg-sky-600 px-4 py-2 text-sm font-medium text-white hover:bg-sky-500 disabled:cursor-not-allowed disabled:opacity-50"
            >
              {running ? 'Replaying…' : 'Run analysis'}
            </button>
          </div>
        </form>
      )}
    </Panel>
  );
}

function Results({ run, analysis }: { run: SimulationRunDto; analysis: RobustnessAnalysisDto }) {
  const { result } = analysis;
  const currency = run.settings.currency;
  const money = (v: number) => formatMinorAmount(v, currency);
  const full = result.full.summary;
  return (
    <>
      <Panel
        title={`Analysis #${analysis.id}`}
        subtitle="Saved result, as calculated by the engine"
      >
        <Rows
          rows={[
            ['Created', formatTimestamp(analysis.createdAt)],
            ['Blocks', String(analysis.windows)],
            ['Rounds', formatCount(analysis.sampleSize)],
            ['Algorithm version', <code key="a">{analysis.algorithmVersion}</code>],
            ['Result format version', String(analysis.resultSchemaVersion)],
            ...(result.staking
              ? ([
                  [
                    'Progression state',
                    'Restarted at the first step in every block and in the full sample',
                  ],
                  ...(['A', 'B'] as const).map((k): [string, ReactNode] => [
                    `Leg ${k} progression key`,
                    result.staking!.legs[k]?.configKey ?? 'Flat stakes',
                  ]),
                ] as [string, ReactNode][])
              : []),
            [
              'Dataset fingerprint (SHA-256)',
              <span key="fp" className="font-mono text-xs break-all">
                {analysis.datasetSha256}
              </span>,
            ],
          ]}
        />
      </Panel>
      <Panel
        title="Full sample"
        subtitle="The whole period replayed once, carrying the bankroll through, as the original run did"
      >
        <Rows
          rows={[
            [
              'Period',
              `${formatTimestamp(result.full.firstEventAt)} – ${formatTimestamp(result.full.lastEventAt)}`,
            ],
            [
              'Rounds replayed',
              `${formatCount(full.roundsReplayed)} of ${formatCount(full.roundsAvailable)}`,
            ],
            ['Starting bankroll', money(full.startingBankrollMinor)],
            ['Ending bankroll', money(full.endingBankrollMinor)],
            ['Net', formatSignedMinor(full.netProfitMinor, currency)],
            [
              'Max drawdown',
              `${formatPercent(full.maxDrawdownFraction)} (${money(full.maxDrawdownMinor)})`,
            ],
            ['Ended because', STOP_REASON_TEXT[full.stopReason]],
          ]}
        />
      </Panel>
      <Panel
        title="Chronological blocks"
        subtitle={`Independent replays, each starting again from ${money(full.startingBankrollMinor)}`}
      >
        <p id="block-note" className="mb-3 text-sm text-slate-400">
          Each row is a separate replay of one period. The rows are not added together, and a block
          that ended above its starting bankroll says nothing about future rounds.
        </p>
        <div className="relative overflow-x-auto">
          <table className="w-full min-w-[64rem] text-left text-sm" aria-describedby="block-note">
            <caption className="sr-only">Chronological block results</caption>
            <thead className="text-xs text-slate-500 uppercase">
              <tr>
                <th scope="col" className="py-2 pr-4 font-medium">
                  Block
                </th>
                <th scope="col" className="py-2 pr-4 font-medium">
                  Period
                </th>
                <th scope="col" className="py-2 pr-4 font-medium">
                  Rounds (positions)
                </th>
                <th scope="col" className="py-2 pr-4 text-right font-medium">
                  Replayed
                </th>
                <th scope="col" className="py-2 pr-4 text-right font-medium">
                  Ending bankroll
                </th>
                <th scope="col" className="py-2 pr-4 text-right font-medium">
                  Net
                </th>
                <th scope="col" className="py-2 pr-4 text-right font-medium">
                  Max drawdown
                </th>
                <th scope="col" className="py-2 pr-4 font-medium">
                  Ended because
                </th>
              </tr>
            </thead>
            <tbody className="divide-y divide-slate-800">
              {result.blocks.map((b) => (
                <BlockRow key={b.index} block={b} currency={currency} />
              ))}
            </tbody>
          </table>
        </div>
      </Panel>
    </>
  );
}

function BlockRow({
  block,
  currency,
}: {
  block: RobustnessAnalysisDto['result']['blocks'][number];
  currency: SimulationRunDto['settings']['currency'];
}) {
  const s: BacktestSummary = block.summary;
  return (
    <tr className="align-top">
      <th scope="row" className="py-2 pr-4 font-normal">
        {block.index + 1}
      </th>
      <td className="py-2 pr-4 text-slate-300">
        {formatTimestamp(block.firstEventAt)}
        <br />
        <span className="text-slate-500">to</span> {formatTimestamp(block.lastEventAt)}
      </td>
      <td className="py-2 pr-4 font-mono text-xs text-slate-400">
        {formatCount(block.roundCount)} ({block.startIndex + 1}–{block.endIndex})
        <br />
        ids {block.firstRoundId}–{block.lastRoundId}
      </td>
      <td className="py-2 pr-4 text-right font-mono">{formatCount(s.roundsReplayed)}</td>
      <td className="py-2 pr-4 text-right font-mono whitespace-nowrap">
        {formatMinorAmount(s.endingBankrollMinor, currency)}
      </td>
      <td className="py-2 pr-4 text-right font-mono whitespace-nowrap">
        {formatSignedMinor(s.netProfitMinor, currency)}
      </td>
      <td className="py-2 pr-4 text-right font-mono">{formatPercent(s.maxDrawdownFraction)}</td>
      <td className="py-2 pr-4 text-slate-300">
        {STOP_REASON_TEXT[s.stopReason]}
        {(['A', 'B'] as const).map((k) => {
          const p = s.progression?.legs[k];
          return p && p.finalBlockReason !== null ? (
            <div key={k} className="text-xs text-slate-400">
              Leg {k}: {SKIP_REASON_TEXT[p.finalBlockReason]}
            </div>
          ) : null;
        })}
      </td>
    </tr>
  );
}
