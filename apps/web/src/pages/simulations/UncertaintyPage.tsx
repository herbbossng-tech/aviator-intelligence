import { useState, type FormEvent, type ReactNode } from 'react';
import { Link, useParams } from 'react-router';
import {
  ANALYSIS_QUANTILE_LEVELS_BPS,
  DEFAULT_ANALYSIS_PATHS,
  MAX_ANALYSIS_SEED,
  STOP_REASON_TEXT,
  STOP_REASONS,
  type SimulationAnalysesList,
  type SimulationAnalysisDto,
  type SimulationRunDto,
} from '@aviator/shared';
import { api, ApiRequestError } from '../../api/client';
import { useApi } from '../../api/useApi';
import { EmptyState } from '../../components/EmptyState';
import { ErrorNotice } from '../../components/ErrorNotice';
import { FormField, inputClass } from '../../components/FormField';
import { Notice } from '../../components/Notice';
import { PageHeader } from '../../components/PageHeader';
import { Panel } from '../../components/Panel';
import { formatCount, formatMinorAmount, formatTimestamp } from '../../lib/format';
import { formatPercent } from '../../lib/stats';
import { formatSignedMinor } from './display';

export const UNCERTAINTY_CAUTION =
  'Resampled results are conditional on the IID bootstrap model and on this one historical sample. They are not a prediction of future rounds, not a real-world probability of loss, and not evidence that a configuration is profitable.';

function randomSeed(): number {
  const words = new Uint32Array(2);
  crypto.getRandomValues(words);
  // 53 random bits: 21 from the first word, 32 from the second.
  return (words[0]! & 0x1f_ffff) * 0x1_0000_0000 + words[1]!;
}

const quantileLabel = (levelBps: number) => `p${String(levelBps / 100).padStart(2, '0')}`;

function Badge({ kind }: { kind: 'observed' | 'resampled' }) {
  return kind === 'observed' ? (
    <span className="rounded bg-sky-500/15 px-1.5 py-0.5 text-xs font-medium text-sky-300 ring-1 ring-sky-500/30">
      Observed
    </span>
  ) : (
    <span className="rounded bg-violet-500/15 px-1.5 py-0.5 text-xs font-medium text-violet-300 ring-1 ring-violet-500/30">
      Resampled
    </span>
  );
}

export function UncertaintyPage() {
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
        title={runId === null ? 'Uncertainty analysis' : `Uncertainty analysis · run #${runId}`}
        description="Resample the run's observed multipliers and replay the same configuration on many paths, to see how much the result depends on the particular historical sequence."
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
        {UNCERTAINTY_CAUTION}
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
  const list = useApi((signal) => api.simulationAnalyses(run.id, signal), [run.id, reload]);
  // Keep the last loaded list on screen while a refresh is in flight, so the form keeps its
  // inputs and the results do not flicker after each run.
  const [loaded, setLoaded] = useState<SimulationAnalysesList>();
  if (list.status === 'success' && list.data !== loaded) setLoaded(list.data);
  const items = loaded?.items ?? [];
  const selected = items.find((a) => a.id === selectedId) ?? items[0] ?? null;

  return (
    <div className="space-y-6">
      <SampleAndMethod run={run} />
      {list.status === 'error' ? <ErrorNotice message={list.message} /> : null}
      {loaded ? (
        <RunForm
          run={run}
          maxPaths={loaded.maxPaths}
          onDone={(analysis) => {
            setSelectedId(analysis.id);
            setReload((n) => n + 1);
          }}
        />
      ) : null}
      {list.status === 'loading' && !loaded ? (
        <p className="text-sm text-slate-400">Loading analyses…</p>
      ) : null}
      {loaded && items.length === 0 ? (
        <Panel title="Resampled results">
          <EmptyState title="No analysis yet">
            Run an analysis above. No example results are shown.
          </EmptyState>
        </Panel>
      ) : null}
      {selected ? <Results run={run} analysis={selected} /> : null}
      {items.length > 1 ? (
        <Panel title="Previous analyses of this run" subtitle="Newest first">
          <div className="relative overflow-x-auto">
            <table className="w-full min-w-[36rem] text-left text-sm">
              <caption className="sr-only">Previous analyses</caption>
              <thead className="text-xs text-slate-500 uppercase">
                <tr>
                  <th scope="col" className="py-2 pr-4 font-medium">
                    Analysis
                  </th>
                  <th scope="col" className="py-2 pr-4 font-medium">
                    Created
                  </th>
                  <th scope="col" className="py-2 pr-4 text-right font-medium">
                    Paths
                  </th>
                  <th scope="col" className="py-2 pr-4 text-right font-medium">
                    Seed
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
                    <td className="py-2 pr-4 text-right font-mono">{formatCount(a.paths)}</td>
                    <td className="py-2 pr-4 text-right font-mono">{a.seed}</td>
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

function SampleAndMethod({ run }: { run: SimulationRunDto }) {
  const report = run.dataset!;
  const summary = run.summary!;
  const money = (v: number) => formatMinorAmount(v, run.settings.currency);
  return (
    <div className="grid gap-6 lg:grid-cols-2">
      <Panel title="Sample" subtitle="Exactly the rounds this run replayed">
        <Rows
          rows={[
            ['Source', report.dataset.source],
            ['Observed rounds (n)', formatCount(report.roundsEligible)],
            ['Excluded: no event time', formatCount(report.excludedNoEventTime)],
            ['Excluded: synthetic test fixtures', formatCount(report.excludedSynthetic)],
            [
              'Dataset fingerprint (SHA-256)',
              <span key="fp" className="font-mono text-xs break-all">
                {run.datasetSha256}
              </span>,
            ],
            [
              'Observed historical result',
              <span key="obs" className="flex flex-wrap items-center gap-2">
                <Badge kind="observed" />
                ending {money(summary.endingBankrollMinor)} · max drawdown{' '}
                {formatPercent(summary.maxDrawdownFraction)} ·{' '}
                {STOP_REASON_TEXT[summary.stopReason]}
              </span>,
            ],
          ]}
        />
      </Panel>
      <Panel title="Method" subtitle="IID empirical bootstrap">
        <ul className="list-disc space-y-1 pl-5 text-sm text-slate-400">
          <li>
            Each path draws n multipliers at random <em>with replacement</em> from the n observed
            multipliers above, then replays this run&apos;s exact configuration from its starting
            bankroll, through the same settlement and accounting as the backtest.
          </li>
          <li>
            This assumes rounds are independent and identically distributed, and ignores their
            order. It can only recombine values that were observed: it never invents a multiplier.
          </li>
          <li>
            More paths make the resampled figures more stable, but add no new historical
            information: everything rests on the same n observations.
          </li>
          <li>
            The seed makes a result exactly reproducible: the same seed, configuration, sample
            fingerprint and algorithm version give identical figures.
          </li>
          <li>
            Ranges below are empirical quantiles of the resampled paths, not confidence intervals.
          </li>
        </ul>
      </Panel>
    </div>
  );
}

function RunForm({
  run,
  maxPaths,
  onDone,
}: {
  run: SimulationRunDto;
  maxPaths: number;
  onDone: (a: SimulationAnalysisDto) => void;
}) {
  const [paths, setPaths] = useState(String(Math.min(DEFAULT_ANALYSIS_PATHS, maxPaths)));
  const [seed, setSeed] = useState(() => String(randomSeed()));
  const [errors, setErrors] = useState<{ paths?: string; seed?: string }>({});
  const [running, setRunning] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const submit = async (event: FormEvent) => {
    event.preventDefault();
    setError(null);
    const next: { paths?: string; seed?: string } = {};
    const p = /^\d{1,7}$/.test(paths.trim()) ? Number(paths.trim()) : NaN;
    if (!(p >= 1 && p <= maxPaths)) next.paths = `Enter a whole number from 1 to ${maxPaths}.`;
    const s = /^\d{1,16}$/.test(seed.trim()) ? Number(seed.trim()) : NaN;
    if (!(Number.isSafeInteger(s) && s >= 0 && s <= MAX_ANALYSIS_SEED)) {
      next.seed = `Enter a whole number from 0 to ${MAX_ANALYSIS_SEED}.`;
    }
    setErrors(next);
    if (Object.keys(next).length > 0) return;
    setRunning(true);
    try {
      onDone(await api.runAnalysis(run.id, { paths: p, seed: s }));
    } catch (e) {
      setError(e instanceof ApiRequestError || e instanceof Error ? e.message : 'Analysis failed.');
    } finally {
      setRunning(false);
    }
  };

  return (
    <Panel title="Run an analysis" subtitle="Virtual money only; nothing is placed anywhere">
      {maxPaths === 0 ? (
        <ErrorNotice message="This run's sample cannot be analysed." />
      ) : (
        <form onSubmit={submit} noValidate aria-label="Uncertainty analysis settings">
          <div className="grid gap-4 sm:grid-cols-2">
            <FormField
              id="paths"
              label="Resampled paths"
              hint={`1 to ${formatCount(maxPaths)} for this sample (work limit: paths × ${formatCount(run.dataset!.roundsEligible)} rounds)`}
              required
              error={errors.paths}
            >
              {(p) => (
                <input
                  {...p}
                  className={inputClass}
                  inputMode="numeric"
                  value={paths}
                  onChange={(e) => setPaths(e.target.value)}
                />
              )}
            </FormField>
            <FormField
              id="seed"
              label="Seed"
              hint="Any whole number; the same seed reproduces the same result"
              required
              error={errors.seed}
            >
              {(p) => (
                <div className="flex gap-2">
                  <input
                    {...p}
                    className={inputClass}
                    inputMode="numeric"
                    value={seed}
                    onChange={(e) => setSeed(e.target.value)}
                  />
                  <button
                    type="button"
                    onClick={() => setSeed(String(randomSeed()))}
                    className="shrink-0 rounded-md px-3 text-xs text-slate-200 ring-1 ring-slate-700 hover:bg-slate-800"
                  >
                    New seed
                  </button>
                </div>
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
              {running ? 'Resampling…' : 'Run analysis'}
            </button>
          </div>
        </form>
      )}
    </Panel>
  );
}

function share(count: number, denominator: number) {
  return `${formatCount(count)} of ${formatCount(denominator)} (${formatPercent(count / denominator)})`;
}

function DistributionTable({
  caption,
  rows,
}: {
  caption: string;
  rows: {
    label: string;
    observed: string | null;
    dist: { min: number; max: number; quantiles: { levelBps: number; value: number }[] };
    format: (v: number) => string;
  }[];
}) {
  return (
    <div className="relative overflow-x-auto">
      <table className="w-full min-w-[44rem] text-left text-sm">
        <caption className="sr-only">{caption}</caption>
        <thead className="text-xs text-slate-500 uppercase">
          <tr>
            <th scope="col" className="py-2 pr-3 font-medium">
              Metric
            </th>
            <th scope="col" className="py-2 pr-3 text-right font-medium">
              Observed
            </th>
            <th scope="col" className="py-2 pr-3 text-right font-medium">
              Min
            </th>
            {ANALYSIS_QUANTILE_LEVELS_BPS.map((l) => (
              <th key={l} scope="col" className="py-2 pr-3 text-right font-medium">
                {quantileLabel(l)}
              </th>
            ))}
            <th scope="col" className="py-2 pr-3 text-right font-medium">
              Max
            </th>
          </tr>
        </thead>
        <tbody className="divide-y divide-slate-800 font-mono whitespace-nowrap tabular-nums">
          {rows.map((r) => (
            <tr key={r.label}>
              <th
                scope="row"
                className="min-w-[8rem] py-2 pr-3 font-sans font-normal whitespace-normal text-slate-300"
              >
                {r.label}
              </th>
              <td className="py-2 pr-3 text-right text-sky-300">{r.observed ?? '—'}</td>
              <td className="py-2 pr-3 text-right">{r.format(r.dist.min)}</td>
              {r.dist.quantiles.map((q) => (
                <td key={q.levelBps} className="py-2 pr-3 text-right text-violet-200">
                  {r.format(q.value)}
                </td>
              ))}
              <td className="py-2 pr-3 text-right">{r.format(r.dist.max)}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

function Results({ run, analysis }: { run: SimulationRunDto; analysis: SimulationAnalysisDto }) {
  const s = analysis.summary;
  const currency = run.settings.currency;
  const money = (v: number) => formatMinorAmount(v, currency);
  const { configuredBoundaries: b, observed: o, netOutcome: n } = s;
  return (
    <Panel
      title={`Resampled results · analysis #${analysis.id}`}
      subtitle={`${formatCount(s.paths)} paths × ${formatCount(s.pathLength)} draws · seed ${s.seed} · ${s.algorithmVersion}`}
      actions={<Badge kind="resampled" />}
    >
      <div className="space-y-6">
        {s.warnings.length > 0 ? (
          <Notice tone="warning">
            <ul className="list-disc space-y-1 pl-5">
              {s.warnings.map((w) => (
                <li key={w.code}>{w.message}</li>
              ))}
            </ul>
          </Notice>
        ) : null}

        <section aria-label="Distributions">
          <h3 className="mb-2 text-sm font-medium text-slate-200">
            Distribution across paths{' '}
            <span className="font-normal text-slate-500">
              (nearest-rank quantiles of {formatCount(s.paths)} paths; not confidence intervals)
            </span>
          </h3>
          <DistributionTable
            caption="Observed value and distribution of resampled path values"
            rows={[
              {
                label: 'Ending bankroll',
                observed: money(o.endingBankrollMinor),
                dist: s.endingBankrollMinor,
                format: money,
              },
              {
                label: 'Max drawdown (% of running peak)',
                observed: formatPercent(o.maxDrawdownFraction),
                dist: s.maxDrawdownFraction,
                format: (v) => formatPercent(v),
              },
              {
                label: 'Max drawdown (amount)',
                observed: money(run.summary!.maxDrawdownMinor),
                dist: s.maxDrawdownMinor,
                format: money,
              },
              {
                label: 'Rounds replayed',
                observed: formatCount(run.summary!.roundsReplayed),
                dist: s.roundsReplayed,
                format: formatCount,
              },
            ]}
          />
        </section>

        <div className="grid gap-6 lg:grid-cols-2">
          <section aria-label="Net outcome of resampled paths">
            <h3 className="mb-2 text-sm font-medium text-slate-200">Net outcome of paths</h3>
            <Rows
              rows={[
                ['Ended above the start (net > 0)', share(n.positive, n.denominator)],
                ['Ended at the start (net = 0)', share(n.zero, n.denominator)],
                ['Ended below the start (net < 0)', share(n.negative, n.denominator)],
                [
                  'Observed run',
                  <span key="o" className="flex flex-wrap items-center gap-2">
                    <Badge kind="observed" />
                    {formatSignedMinor(run.summary!.netProfitMinor, currency)}
                  </span>,
                ],
                ['Paths ending below the observed', share(o.pathsEndingBelow, o.denominator)],
                ['Paths ending equal to the observed', share(o.pathsEndingEqual, o.denominator)],
                ['Paths ending above the observed', share(o.pathsEndingAbove, o.denominator)],
              ]}
            />
          </section>

          <section aria-label="Configured virtual-bankroll boundaries">
            <h3 className="mb-2 text-sm font-medium text-slate-200">Configured boundaries</h3>
            <Rows
              rows={[
                [
                  'Lower bankroll stop',
                  b.lowerBankrollStop === null
                    ? 'Not configured for this run'
                    : `${share(b.lowerBankrollStop.count, b.lowerBankrollStop.denominator)} of paths ended by falling below ${money(b.lowerBankrollStop.thresholdMinor)}`,
                ],
                [
                  'Drawdown stop',
                  b.maxDrawdownStop === null
                    ? 'Not configured for this run'
                    : `${share(b.maxDrawdownStop.count, b.maxDrawdownStop.denominator)} of paths ended by a drawdown of at least ${(b.maxDrawdownStop.thresholdBps / 100).toFixed(2)}%`,
                ],
              ]}
            />
            <p className="mt-2 text-xs text-slate-500">
              The fraction of resampled paths that reached the configured virtual-bankroll boundary
              under this bootstrap model. It is not a probability of real-world loss.
            </p>
          </section>
        </div>

        <section aria-label="How paths ended">
          <h3 className="mb-2 text-sm font-medium text-slate-200">How paths ended</h3>
          <div className="relative overflow-x-auto">
            <table className="w-full min-w-[30rem] text-left text-sm">
              <caption className="sr-only">Paths by stop reason</caption>
              <thead className="text-xs text-slate-500 uppercase">
                <tr>
                  <th scope="col" className="py-2 pr-4 font-medium">
                    Stop reason
                  </th>
                  <th scope="col" className="py-2 pr-4 text-right font-medium">
                    Paths
                  </th>
                </tr>
              </thead>
              <tbody className="divide-y divide-slate-800">
                {STOP_REASONS.map((reason) => (
                  <tr key={reason}>
                    <th scope="row" className="py-2 pr-4 font-normal text-slate-300">
                      {STOP_REASON_TEXT[reason]}
                    </th>
                    <td className="py-2 pr-4 text-right font-mono whitespace-nowrap">
                      {share(s.stopReasons[reason], s.paths)}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </section>

        <p className="text-xs text-slate-500">
          Sample: {formatCount(s.sample.size)} observed rounds,{' '}
          {formatCount(s.sample.distinctMultipliers)} distinct multipliers. Fingerprint{' '}
          {analysis.datasetSha256.slice(0, 16)}…, created {formatTimestamp(analysis.createdAt)}.
        </p>
      </div>
    </Panel>
  );
}
