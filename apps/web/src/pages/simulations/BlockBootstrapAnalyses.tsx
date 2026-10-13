import { useRef, useState, type FormEvent, type ReactNode } from 'react';
import { useSearchParams } from 'react-router';
import {
  FEW_CANDIDATE_BLOCKS,
  MAX_ANALYSIS_SEED,
  MIN_BLOCK_BOOTSTRAP_SAMPLE,
  MIN_BLOCK_LENGTH,
  MIN_BLOCKS_PER_PATH,
  DEFAULT_ANALYSIS_PATHS,
  movingBlockLayout,
  type BlockAnalysesList,
  type BlockAnalysisDto,
  type ProgressionConfig,
  type SimulationRunDto,
} from '@aviator/shared';
import { api, ApiRequestError } from '../../api/client';
import { useApi } from '../../api/useApi';
import { EmptyState } from '../../components/EmptyState';
import { ErrorNotice } from '../../components/ErrorNotice';
import { FormField, inputClass } from '../../components/FormField';
import { Notice } from '../../components/Notice';
import { Panel } from '../../components/Panel';
import { formatCount, formatMinorAmount, formatTimestamp } from '../../lib/format';
import { formatPercent } from '../../lib/stats';
import { describeProgression } from './display';
import {
  Badge,
  DistributionTable,
  PathOutcomes,
  randomSeed,
  Rows,
  SamplePanel,
} from './resamplingDisplay';

// VIRTUAL MONEY ONLY. The moving-block bootstrap view: a separate resource from the IID
// analyses (its own endpoint, list and settings). The server computes, validates and stores
// every result; this page only chooses paths, seed and block length and displays the result.

export const BLOCK_UNCERTAINTY_CAUTION =
  'Resampled results are conditional on the moving-block bootstrap model, on the chosen block length and on this one historical sample. They are not a prediction of future rounds, not a real-world probability of loss, and not evidence that a configuration is profitable.';

export const LONGEST_LOSING_STREAK_DEFINITION =
  'Longest losing streak: the most consecutive rounds on a path with a negative combined net outcome across both legs; a break-even round ends the streak. Counted in rounds. A streak can continue across the join between two blocks.';

const BLOCK_PROGRESSION_NOTE =
  "This run uses a staking progression. Every resampled path replays the run's stored plan: each progression starts at its first step on every path, and each leg follows only its own results on that path. Bankroll skips and step, stake and exposure limits work exactly as in the backtest. Within a block, losing and winning rounds keep their recorded order, so streaks inside a block are kept as recorded; where two blocks join, the order is random. A progression does not create an edge or guarantee recovery.";

/** Plain-language explanations shown under the server's own warning text. */
function warningExplanation(code: string, analysis: BlockAnalysisDto): string | null {
  if (code !== 'few_candidate_blocks') return null;
  const { candidateStarts, blockLength } = analysis.summary.resampling;
  return `What this means: a block can start at only ${formatCount(candidateStarts)} positions (n − b + 1 with b = ${formatCount(blockLength)}), fewer than ${FEW_CANDIDATE_BLOCKS}. Many paths are built from the same few stretches, so they resemble each other and the spread of results can look narrower than one sample can support. A shorter block length gives more possible stretches.`;
}

const parseId = (value: string | null) =>
  value !== null && /^[1-9]\d{0,15}$/.test(value) ? Number(value) : null;

/** "15 blocks of 4 rounds", or "14 blocks of 4 rounds plus one of 2". */
function describeLayout(blocksPerPath: number, blockLength: number, lastBlockLength: number) {
  const rounds = (k: number) => `${formatCount(k)} ${k === 1 ? 'round' : 'rounds'}`;
  return lastBlockLength === blockLength
    ? `${formatCount(blocksPerPath)} blocks of ${rounds(blockLength)}`
    : `${formatCount(blocksPerPath - 1)} blocks of ${rounds(blockLength)} plus one of ${formatCount(lastBlockLength)}`;
}

const maxStepsOf = (config: ProgressionConfig) =>
  config.mode === 'custom' ? config.stakesMinor.length : config.limits.maxSteps;

/** Each progression leg's step limit beside the block length (design §5.5). */
function stepLimitRows(run: SimulationRunDto, blockLength: number): [string, ReactNode][] {
  if (run.staking === null) return [];
  return (['A', 'B'] as const).flatMap((k): [string, ReactNode][] => {
    const config = run.staking!.legs[k];
    if (config === null) return [];
    const steps = maxStepsOf(config);
    return [
      [
        `Leg ${k}: step limit beside block length`,
        `${formatCount(steps)} ${steps === 1 ? 'step' : 'steps'} · block length ${formatCount(blockLength)} rounds${
          blockLength < steps
            ? '. A losing streak long enough to reach this limit cannot fit inside one block, so it can only form by chance across block joins.'
            : ''
        }`,
      ],
    ];
  });
}

export function BlockAnalyses({ run }: { run: SimulationRunDto }) {
  const [searchParams, setSearchParams] = useSearchParams();
  const selectedId = parseId(searchParams.get('analysis'));
  const select = (id: number | null) =>
    setSearchParams(
      id === null ? { method: 'moving-block' } : { method: 'moving-block', analysis: String(id) },
      { replace: true },
    );

  const [reload, setReload] = useState(0);
  const list = useApi((signal) => api.blockAnalyses(run.id, signal), [run.id, reload]);
  // Keep the last loaded list on screen while a refresh is in flight, so the form keeps its
  // inputs and the results do not flicker after each run.
  const [loaded, setLoaded] = useState<BlockAnalysesList>();
  if (list.status === 'success' && list.data !== loaded) setLoaded(list.data);
  const items = loaded?.items ?? [];
  // The analysis just created is the server's own response: it is shown while the refreshed
  // list loads, without another request.
  const [created, setCreated] = useState<BlockAnalysisDto | null>(null);

  const listed =
    selectedId === null
      ? (items[0] ?? null)
      : (items.find((a) => a.id === selectedId) ??
        (created !== null && created.id === selectedId ? created : null));
  // A selected analysis outside the loaded list (an older one, or a link) is read once from
  // the detail endpoint. It is only read, never recomputed.
  const detailId = loaded && selectedId !== null && listed === null ? selectedId : null;
  const detail = useApi(
    async (signal) => {
      if (detailId === null) return null;
      try {
        return { analysis: await api.blockAnalysis(run.id, detailId, signal) };
      } catch (e) {
        if (e instanceof ApiRequestError && e.status === 404) return { notFound: detailId };
        throw e;
      }
    },
    [run.id, detailId],
  );

  let shown: ReactNode = null;
  if (listed) shown = <BlockResults run={run} analysis={listed} />;
  else if (detailId !== null) {
    if (detail.status === 'loading') {
      shown = (
        <p className="text-sm text-slate-400" role="status">
          Loading block analysis #{detailId}…
        </p>
      );
    } else if (detail.status === 'error') {
      shown = <ErrorNotice message={detail.message} />;
    } else if (detail.data && 'analysis' in detail.data) {
      shown = <BlockResults run={run} analysis={detail.data.analysis} />;
    } else if (detail.data) {
      shown = (
        <div className="space-y-2">
          <ErrorNotice
            message={`Block analysis #${detail.data.notFound} was not found for this run. The link may be wrong, or the analysis may belong to another run.`}
          />
          {items.length > 0 ? (
            <button
              type="button"
              onClick={() => select(null)}
              className="rounded px-2 py-1 text-xs text-slate-200 ring-1 ring-slate-700 hover:bg-slate-800"
            >
              Show the newest block analysis
            </button>
          ) : null}
        </div>
      );
    }
  }
  const shownId = listed?.id ?? (detail.status === 'success' ? detailId : null);

  return (
    <div className="space-y-6">
      <div className="grid gap-6 lg:grid-cols-2">
        <SamplePanel run={run} />
        <BlockMethodPanel run={run} />
      </div>
      {list.status === 'error' ? <ErrorNotice message={list.message} /> : null}
      {loaded ? (
        loaded.maxBlockLength === 0 ? (
          <SampleTooSmall sampleSize={loaded.sampleSize} />
        ) : (
          <BlockRunForm
            run={run}
            limits={loaded}
            onDone={(analysis) => {
              setCreated(analysis);
              select(analysis.id);
              setReload((n) => n + 1);
            }}
          />
        )
      ) : null}
      {list.status === 'loading' && !loaded ? (
        <p className="text-sm text-slate-400" role="status">
          Loading block analyses…
        </p>
      ) : null}
      {loaded && items.length === 0 && created === null && selectedId === null ? (
        <Panel title="Moving-block results">
          <EmptyState title="No block analysis yet">
            {loaded.maxBlockLength === 0
              ? 'This sample is too small for a block bootstrap. No example results are shown.'
              : 'Run a block analysis above. No example results are shown.'}
          </EmptyState>
        </Panel>
      ) : null}
      {shown}
      {items.length > 0 ? (
        <SavedBlockAnalyses
          items={items}
          total={loaded!.total}
          shownId={shownId}
          onShow={(id) => select(id)}
        />
      ) : null}
    </div>
  );
}

function BlockMethodPanel({ run }: { run: SimulationRunDto }) {
  return (
    <Panel title="Method" subtitle="Moving-block bootstrap">
      <ul className="list-disc space-y-1 pl-5 text-sm text-slate-400">
        <li>
          Each path is built from <em>blocks</em>: stretches of b consecutive rounds of the sample,
          in their recorded order. Every block starts at a position chosen at random from the n − b
          + 1 possible starts; blocks are joined in the order drawn and the path is cut to n rounds.
          The path then replays this run&apos;s exact configuration from its starting bankroll,
          through the same settlement and accounting as the backtest.
        </li>
        <li>
          Unlike the IID bootstrap, which draws single rounds independently, order is kept{' '}
          <em>within</em> each block, so short-range patterns in the recording can carry into the
          paths. Order between blocks is not kept.
        </li>
        <li>
          Keeping order is a robustness check, not a claim that rounds influence each other: crash
          rounds are designed to be independent. Losing streaks longer than the block length can
          only form by chance across block joins.
        </li>
        <li>
          Blocks may overlap, and the same block may be drawn more than once on a path. Blocks never
          wrap from the end of the sample back to its start, so rounds near either end appear in
          fewer possible blocks.
        </li>
        <li>
          The sample is this run&apos;s eligible rounds in recorded order. A block can span a gap in
          the recording (for example two sessions recorded days apart) and treats those rounds as
          consecutive.
        </li>
        <li>
          Results are conditional on this one sample, the block length, and this run&apos;s strategy
          and staking. Another block length can give different figures: comparing a few values, and
          the IID method, is a sensitivity check, not a search for a better result.
        </li>
        <li>
          It does not test whether rounds depend on each other, does not predict future rounds, and
          does not show an edge or guarantee anything.
        </li>
        <li>
          The seed makes a result exactly reproducible: the same seed, block length, configuration,
          sample fingerprint and algorithm version give identical figures. Ranges below are
          empirical quantiles of the resampled paths, not confidence intervals.
        </li>
        {run.staking === null ? null : <li>{BLOCK_PROGRESSION_NOTE}</li>}
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
  );
}

function SampleTooSmall({ sampleSize }: { sampleSize: number | null }) {
  return (
    <Panel title="Run a block analysis" subtitle="Virtual money only; nothing is placed anywhere">
      <Notice tone="info">
        {sampleSize === null
          ? 'This run has no usable sample, so it cannot be analysed by blocks.'
          : `This run's sample has ${formatCount(sampleSize)} rounds. A block bootstrap needs at least ${MIN_BLOCK_BOOTSTRAP_SAMPLE}, so that every path can be built from at least ${MIN_BLOCKS_PER_PATH} blocks of at least ${MIN_BLOCK_LENGTH} rounds.`}{' '}
        The IID method can still be used, or a backtest can be run on a larger dataset.
      </Notice>
    </Panel>
  );
}

type FieldErrors = { paths?: string; seed?: string; blockLength?: string };

function BlockRunForm({
  run,
  limits,
  onDone,
}: {
  run: SimulationRunDto;
  limits: BlockAnalysesList;
  onDone: (a: BlockAnalysisDto) => void;
}) {
  const { maxPaths, maxBlockLength } = limits;
  const n = limits.sampleSize!;
  const defaultLength = limits.defaultBlockLength!;
  const [paths, setPaths] = useState(String(Math.min(DEFAULT_ANALYSIS_PATHS, maxPaths)));
  const [seed, setSeed] = useState(() => String(randomSeed()));
  const [blockLength, setBlockLength] = useState(String(defaultLength));
  const [errors, setErrors] = useState<FieldErrors>({});
  const [running, setRunning] = useState(false);
  const inFlight = useRef(false);
  const [error, setError] = useState<string | null>(null);

  const b = /^\d{1,4}$/.test(blockLength.trim()) ? Number(blockLength.trim()) : NaN;
  const bValid = b >= MIN_BLOCK_LENGTH && b <= maxBlockLength;
  const layout = bValid ? movingBlockLayout(n, b) : null;
  const shortestLimit = Math.min(
    ...(['A', 'B'] as const).flatMap((k) => {
      const config = run.staking?.legs[k] ?? null;
      return config === null ? [] : [maxStepsOf(config)];
    }),
  );
  const stepNote =
    layout !== null && Number.isFinite(shortestLimit) && layout.blockLength < shortestLimit
      ? ` This is shorter than a progression's step limit (${formatCount(shortestLimit)}), so streaks reaching it can only form across block joins.`
      : '';

  const submit = async (event: FormEvent) => {
    event.preventDefault();
    if (inFlight.current) return;
    setError(null);
    const next: FieldErrors = {};
    const p = /^\d{1,7}$/.test(paths.trim()) ? Number(paths.trim()) : NaN;
    if (!(p >= 1 && p <= maxPaths)) next.paths = `Enter a whole number from 1 to ${maxPaths}.`;
    const s = /^\d{1,16}$/.test(seed.trim()) ? Number(seed.trim()) : NaN;
    if (!(Number.isSafeInteger(s) && s >= 0 && s <= MAX_ANALYSIS_SEED)) {
      next.seed = `Enter a whole number from 0 to ${MAX_ANALYSIS_SEED}.`;
    }
    if (!bValid) {
      next.blockLength = `Enter a whole number from ${MIN_BLOCK_LENGTH} to ${maxBlockLength}.`;
    }
    setErrors(next);
    if (Object.keys(next).length > 0) return;
    inFlight.current = true;
    setRunning(true);
    try {
      onDone(await api.runBlockAnalysis(run.id, { paths: p, seed: s, blockLength: b }));
    } catch (e) {
      const message =
        e instanceof ApiRequestError || e instanceof Error ? e.message : 'Analysis failed.';
      // The server is authoritative: its limit errors are also shown on the field concerned.
      if (e instanceof ApiRequestError && e.code === 'block_length_too_large') {
        setErrors({ blockLength: message });
      } else if (e instanceof ApiRequestError && e.code === 'analysis_too_large') {
        setErrors({ paths: message });
      }
      setError(message);
    } finally {
      inFlight.current = false;
      setRunning(false);
    }
  };

  return (
    <Panel title="Run a block analysis" subtitle="Virtual money only; nothing is placed anywhere">
      <form
        onSubmit={submit}
        noValidate
        aria-label="Moving-block bootstrap settings"
        aria-busy={running}
      >
        <div className="grid gap-4 sm:grid-cols-3">
          <FormField
            id="block-length"
            label="Block length (rounds per block)"
            hint={`Default ${defaultLength} for n = ${formatCount(n)}: the cube root of n, rounded, a common convention rather than the best choice for this data. ${MIN_BLOCK_LENGTH} to ${maxBlockLength} for this sample, so every path has at least ${MIN_BLOCKS_PER_PATH} blocks.`}
            required
            error={errors.blockLength}
          >
            {(p) => (
              <div className="flex gap-2">
                <input
                  {...p}
                  className={inputClass}
                  inputMode="numeric"
                  value={blockLength}
                  onChange={(e) => setBlockLength(e.target.value)}
                />
                <button
                  type="button"
                  onClick={() => setBlockLength(String(defaultLength))}
                  disabled={blockLength.trim() === String(defaultLength)}
                  className="shrink-0 rounded-md px-3 text-xs text-slate-200 ring-1 ring-slate-700 hover:bg-slate-800 disabled:opacity-50"
                >
                  Use default
                </button>
              </div>
            )}
          </FormField>
          <FormField
            id="block-paths"
            label="Resampled paths"
            hint={`1 to ${formatCount(maxPaths)} for this sample (work limit: paths × ${formatCount(n)} rounds)`}
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
            id="block-seed"
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
        <p className="mt-3 text-xs text-slate-500" aria-live="polite" data-testid="block-layout">
          {layout === null
            ? 'Enter a valid block length to see how each path is built.'
            : `With b = ${layout.blockLength}: each path is ${describeLayout(layout.blocksPerPath, layout.blockLength, layout.lastBlockLength)}, each block starting at one of ${formatCount(layout.candidateStarts)} possible positions.${stepNote}${layout.candidateStarts < FEW_CANDIDATE_BLOCKS ? ` That is fewer than ${FEW_CANDIDATE_BLOCKS} possible starts, so paths will reuse the same stretches heavily and the result will carry a warning.` : ''}`}
        </p>
        <div className="mt-4 space-y-3" aria-live="polite">
          {error ? <ErrorNotice message={error} /> : null}
          <button
            type="submit"
            disabled={running}
            className="rounded-md bg-sky-600 px-4 py-2 text-sm font-medium text-white hover:bg-sky-500 disabled:cursor-not-allowed disabled:opacity-50"
          >
            {running ? 'Resampling blocks…' : 'Run block analysis'}
          </button>
        </div>
      </form>
    </Panel>
  );
}

function BlockResults({ run, analysis }: { run: SimulationRunDto; analysis: BlockAnalysisDto }) {
  const s = analysis.summary;
  const r = s.resampling;
  const money = (v: number) => formatMinorAmount(v, run.settings.currency);
  const o = s.observed;
  return (
    <Panel
      title={`Moving-block results · analysis #${analysis.id}`}
      subtitle={`Moving-block bootstrap · block length ${r.blockLength} · ${formatCount(s.paths)} paths × ${formatCount(s.pathLength)} rounds · seed ${s.seed}`}
      actions={
        <Badge kind="resampled" label={`Resampled (block bootstrap, b = ${r.blockLength})`} />
      }
    >
      <div className="space-y-6">
        {s.warnings.length > 0 ? (
          <Notice tone="warning">
            <ul className="list-disc space-y-2 pl-5">
              {s.warnings.map((w) => {
                const explanation = warningExplanation(w.code, analysis);
                return (
                  <li key={w.code}>
                    {w.message}
                    {explanation ? <span className="mt-1 block">{explanation}</span> : null}
                  </li>
                );
              })}
            </ul>
          </Notice>
        ) : null}

        <section aria-label="Analysis details">
          <h3 className="mb-2 text-sm font-medium text-slate-200">Analysis details</h3>
          <Rows
            rows={[
              ['Method', 'Moving-block bootstrap (non-circular)'],
              ['Paths', formatCount(s.paths)],
              ['Sample size (n)', `${formatCount(analysis.sampleSize)} rounds`],
              ['Block length (b)', `${formatCount(r.blockLength)} rounds`],
              [
                'Blocks per path',
                `${formatCount(r.blocksPerPath)}: ${describeLayout(r.blocksPerPath, r.blockLength, r.lastBlockLength)}`,
              ],
              ['Possible block starts (n − b + 1)', formatCount(r.candidateStarts)],
              ['Seed', String(analysis.seed)],
              [
                'Algorithm version',
                <span key="v" className="font-mono text-xs break-all">
                  {analysis.algorithmVersion}
                </span>,
              ],
              ['Created', formatTimestamp(analysis.createdAt)],
              ['Completed', formatTimestamp(analysis.completedAt)],
              ...stepLimitRows(run, r.blockLength),
            ]}
          />
        </section>

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
              {
                label: 'Longest losing streak (rounds)',
                observed: formatCount(run.summary!.longestLosingStreak),
                dist: s.longestLosingStreak,
                format: formatCount,
              },
            ]}
          />
          <p className="mt-2 text-xs text-slate-500">{LONGEST_LOSING_STREAK_DEFINITION}</p>
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

function SavedBlockAnalyses({
  items,
  total,
  shownId,
  onShow,
}: {
  items: BlockAnalysisDto[];
  total: number;
  shownId: number | null;
  onShow: (id: number) => void;
}) {
  return (
    <Panel
      title="Saved block analyses of this run"
      subtitle={
        total > items.length
          ? `Newest first · showing the newest ${formatCount(items.length)} of ${formatCount(total)}`
          : 'Newest first · moving-block bootstrap only (IID analyses are listed under the IID method)'
      }
    >
      <div className="relative overflow-x-auto">
        <table className="w-full min-w-[40rem] text-left text-sm">
          <caption className="sr-only">Saved moving-block bootstrap analyses</caption>
          <thead className="text-xs text-slate-500 uppercase">
            <tr>
              <th scope="col" className="py-2 pr-4 font-medium">
                Analysis
              </th>
              <th scope="col" className="py-2 pr-4 font-medium">
                Created
              </th>
              <th scope="col" className="py-2 pr-4 text-right font-medium">
                Block length
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
                <td className="py-2 pr-4 text-right font-mono">{formatCount(a.blockLength)}</td>
                <td className="py-2 pr-4 text-right font-mono">{formatCount(a.paths)}</td>
                <td className="py-2 pr-4 text-right font-mono">{a.seed}</td>
                <td className="py-2 pr-4">
                  <button
                    type="button"
                    onClick={() => onShow(a.id)}
                    aria-pressed={a.id === shownId}
                    className="rounded px-2 py-1 text-xs ring-1 ring-slate-700 hover:bg-slate-800 aria-pressed:bg-slate-800"
                  >
                    {a.id === shownId ? 'Showing' : `Show block analysis #${a.id}`}
                  </button>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </Panel>
  );
}
