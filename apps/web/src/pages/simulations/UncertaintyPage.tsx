import { useState, type FormEvent } from 'react';
import { Link, useParams, useSearchParams } from 'react-router';
import {
  DEFAULT_ANALYSIS_PATHS,
  MAX_ANALYSIS_SEED,
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
import { BLOCK_UNCERTAINTY_CAUTION, BlockAnalyses } from './BlockBootstrapAnalyses';
import { MethodComparison } from './MethodComparison';
import { BOOTSTRAP_PROGRESSION_NOTE, describeProgression } from './display';
import {
  Badge,
  DistributionTable,
  PathOutcomes,
  randomSeed,
  Rows,
  SamplePanel,
} from './resamplingDisplay';

export const UNCERTAINTY_CAUTION =
  'Resampled results are conditional on the IID bootstrap model and on this one historical sample. They are not a prediction of future rounds, not a real-world probability of loss, and not evidence that a configuration is profitable.';

/** The resampling method, kept in the URL (`?method=moving-block`); IID unless stated. */
export type ResamplingMethod = 'iid' | 'moving-block';

const METHOD_OPTIONS: { value: ResamplingMethod; label: string; description: string }[] = [
  {
    value: 'iid',
    label: 'Independent rounds (IID bootstrap)',
    description:
      'Draws single rounds independently from the sample, ignoring their recorded order.',
  },
  {
    value: 'moving-block',
    label: 'Blocks of consecutive rounds (moving-block bootstrap)',
    description:
      'Draws stretches of consecutive recorded rounds, keeping their order within each stretch.',
  },
];

function MethodSelector({
  method,
  onChange,
}: {
  method: ResamplingMethod;
  onChange: (m: ResamplingMethod) => void;
}) {
  return (
    <fieldset className="mb-6 rounded-lg border border-slate-800 bg-slate-900/40 px-5 py-4">
      <legend className="px-1 text-sm font-medium text-slate-200">Resampling method</legend>
      <div className="grid gap-3 sm:grid-cols-2">
        {METHOD_OPTIONS.map((o) => (
          <label
            key={o.value}
            className="flex cursor-pointer gap-3 rounded-md p-3 ring-1 ring-slate-800 has-[:checked]:bg-slate-800/60 has-[:checked]:ring-sky-600 has-[:focus-visible]:ring-2 has-[:focus-visible]:ring-sky-500"
          >
            <input
              type="radio"
              name="resampling-method"
              value={o.value}
              checked={method === o.value}
              onChange={() => onChange(o.value)}
              aria-describedby={`method-${o.value}-description`}
              className="mt-0.5 accent-sky-500"
            />
            <span>
              <span className="block text-sm text-slate-200">{o.label}</span>
              <span
                id={`method-${o.value}-description`}
                className="mt-0.5 block text-xs text-slate-500"
              >
                {o.description}
              </span>
            </span>
          </label>
        ))}
      </div>
      <p className="mt-3 text-xs text-slate-500">
        Each method keeps its own settings and its own saved analyses. Neither predicts future
        rounds.
      </p>
    </fieldset>
  );
}

export function UncertaintyPage() {
  const { id } = useParams();
  const [searchParams, setSearchParams] = useSearchParams();
  const method: ResamplingMethod =
    searchParams.get('method') === 'moving-block' ? 'moving-block' : 'iid';
  const chooseMethod = (next: ResamplingMethod) =>
    // A method change also drops any analysis selected under the other method.
    setSearchParams(next === 'iid' ? {} : { method: next }, { replace: true });
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
        {method === 'iid' ? UNCERTAINTY_CAUTION : BLOCK_UNCERTAINTY_CAUTION}
      </div>
      <MethodSelector method={method} onChange={chooseMethod} />
      <div className="mb-6">
        <MethodComparison selected={method} />
      </div>
      {run.status === 'loading' ? <p className="text-sm text-slate-400">Loading run…</p> : null}
      {run.status === 'error' ? <ErrorNotice message={run.message} /> : null}
      {run.status === 'success' ? (
        run.data.status !== 'completed' || run.data.summary === null ? (
          <ErrorNotice message="This run failed and has no results, so it cannot be analysed." />
        ) : method === 'iid' ? (
          <Analyses run={run.data} />
        ) : (
          <BlockAnalyses run={run.data} />
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
  // The analysis just created stays selected while the refreshed list loads (it is the
  // server's own response), instead of falling back to the previous newest analysis.
  const [created, setCreated] = useState<SimulationAnalysisDto | null>(null);
  const selected =
    items.find((a) => a.id === selectedId) ??
    (created !== null && created.id === selectedId ? created : null) ??
    items[0] ??
    null;

  return (
    <div className="space-y-6">
      <SampleAndMethod run={run} />
      {list.status === 'error' ? <ErrorNotice message={list.message} /> : null}
      {loaded ? (
        <RunForm
          run={run}
          maxPaths={loaded.maxPaths}
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

function SampleAndMethod({ run }: { run: SimulationRunDto }) {
  return (
    <div className="grid gap-6 lg:grid-cols-2">
      <SamplePanel run={run} />
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
          {run.staking === null ? null : <li>{BOOTSTRAP_PROGRESSION_NOTE}</li>}
        </ul>
        {run.staking === null ? null : (
          <Rows
            rows={(['A', 'B'] as const).map((k) => {
              const config = run.staking!.legs[k];
              return [
                `Leg ${k} staking`,
                config === null
                  ? 'Flat (same stake every round)'
                  : describeProgression(config, run.settings.currency),
              ];
            })}
          />
        )}
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

function Results({ run, analysis }: { run: SimulationRunDto; analysis: SimulationAnalysisDto }) {
  const s = analysis.summary;
  const currency = run.settings.currency;
  const money = (v: number) => formatMinorAmount(v, currency);
  const o = s.observed;
  return (
    <Panel
      title={`Resampled results · analysis #${analysis.id}`}
      subtitle={`IID bootstrap · ${formatCount(s.paths)} paths × ${formatCount(s.pathLength)} draws · seed ${s.seed} · ${s.algorithmVersion}`}
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
                observed: money(o.maxDrawdownMinor),
                dist: s.maxDrawdownMinor,
                format: money,
              },
              {
                label: 'Rounds replayed',
                observed: formatCount(o.roundsReplayed),
                dist: s.roundsReplayed,
                format: formatCount,
              },
            ]}
          />
        </section>

        <PathOutcomes run={run} s={s} />

        <p className="text-xs text-slate-500">
          Sample: {formatCount(s.sample.size)} observed rounds,{' '}
          {formatCount(s.sample.distinctMultipliers)} distinct multipliers. Fingerprint{' '}
          {analysis.datasetSha256.slice(0, 16)}…, created {formatTimestamp(analysis.createdAt)}.
        </p>
      </div>
    </Panel>
  );
}
