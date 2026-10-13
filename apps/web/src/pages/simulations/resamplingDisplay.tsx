import type { ReactNode } from 'react';
import {
  ANALYSIS_QUANTILE_LEVELS_BPS,
  STOP_REASON_TEXT,
  STOP_REASONS,
  type BootstrapSummary,
  type SimulationRunDto,
} from '@aviator/shared';
import { Panel } from '../../components/Panel';
import { formatCount, formatMinorAmount } from '../../lib/format';
import { formatPercent } from '../../lib/stats';
import { formatSignedMinor, PROGRESSION_MODE_TEXT } from './display';

// Presentation shared by the IID and moving-block uncertainty analyses. Both summaries carry
// these fields with the same meaning, so they are shown the same way.

export function randomSeed(): number {
  const words = new Uint32Array(2);
  crypto.getRandomValues(words);
  // 53 random bits: 21 from the first word, 32 from the second.
  return (words[0]! & 0x1f_ffff) * 0x1_0000_0000 + words[1]!;
}

const quantileLabel = (levelBps: number) => `p${String(levelBps / 100).padStart(2, '0')}`;

export function Badge({ kind, label }: { kind: 'observed' | 'resampled'; label?: string }) {
  return kind === 'observed' ? (
    <span className="rounded bg-sky-500/15 px-1.5 py-0.5 text-xs font-medium text-sky-300 ring-1 ring-sky-500/30">
      Observed
    </span>
  ) : (
    <span className="rounded bg-violet-500/15 px-1.5 py-0.5 text-xs font-medium text-violet-300 ring-1 ring-violet-500/30">
      {label ?? 'Resampled'}
    </span>
  );
}

export function Rows({ rows }: { rows: [string, ReactNode][] }) {
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

export function share(count: number, denominator: number) {
  return `${formatCount(count)} of ${formatCount(denominator)} (${formatPercent(count / denominator)})`;
}

export function DistributionTable({
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

/** The fields both resampling summaries share, with identical meaning. */
type CommonSummary = Pick<
  BootstrapSummary,
  'paths' | 'netOutcome' | 'observed' | 'configuredBoundaries' | 'stopReasons' | 'staking'
>;

/** Net outcome, configured boundaries, stop reasons and staking, as counts of paths. */
export function PathOutcomes({ run, s }: { run: SimulationRunDto; s: CommonSummary }) {
  const currency = run.settings.currency;
  const money = (v: number) => formatMinorAmount(v, currency);
  const { configuredBoundaries: b, observed: o, netOutcome: n } = s;
  return (
    <>
      <div className="grid gap-6 lg:grid-cols-2">
        <section aria-label="Net outcome of resampled paths">
          <h3 className="mb-2 text-sm font-medium text-slate-200">Net outcome of paths</h3>
          <p className="mb-2 text-xs text-slate-500">
            Shares of the {formatCount(n.denominator)} resampled paths under this model, not chances
            of making money in future rounds.
          </p>
          <Rows
            rows={[
              ['Ended above the start (net > 0)', share(n.positive, n.denominator)],
              ['Ended at the start (net = 0)', share(n.zero, n.denominator)],
              ['Ended below the start (net < 0)', share(n.negative, n.denominator)],
              [
                'Observed run',
                <span key="o" className="flex flex-wrap items-center gap-2">
                  <Badge kind="observed" />
                  {formatSignedMinor(o.netProfitMinor, currency)}
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
            The fraction of resampled paths that ended because they reached the configured
            virtual-bankroll boundary under this bootstrap model. It is not a probability of
            real-world loss. Each path is counted under one stop only (see below), so a low count
            does not mean paths never crossed that threshold.
          </p>
        </section>
      </div>

      <section aria-label="How paths ended">
        <h3 className="mb-2 text-sm font-medium text-slate-200">How paths ended</h3>
        <p id="stop-precedence" className="mb-2 text-xs text-slate-500">
          Each path is counted once, under the first stop the engine checks after a round: lower
          bankroll stop, then upper stop, then drawdown stop. A path that breaches several
          thresholds in the same round counts only under the first, so a zero for a later stop does
          not mean no path crossed it.
        </p>
        <div className="relative overflow-x-auto">
          <table
            className="w-full min-w-[30rem] text-left text-sm"
            aria-describedby="stop-precedence"
          >
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

      {s.staking ? (
        <section aria-label="Staking progressions on resampled paths">
          <h3 className="mb-2 text-sm font-medium text-slate-200">
            Staking progressions{' '}
            <span className="font-normal text-slate-500">
              (restarted at the first step on every path)
            </span>
          </h3>
          <Rows
            rows={(['A', 'B'] as const).flatMap((k): [string, ReactNode][] => {
              const leg = s.staking!.legs[k];
              if (leg === null) return [[`Leg ${k}`, 'Flat stakes']];
              return [
                [`Leg ${k}`, `${PROGRESSION_MODE_TEXT[leg.mode]} · ${leg.configKey}`],
                [
                  `Leg ${k}: paths where a limit stopped it`,
                  share(leg.pathsStoppedByLimit, leg.denominator),
                ],
                [
                  `Leg ${k}: paths with a stake the bankroll could not fund`,
                  share(leg.pathsWithBankrollSkips, leg.denominator),
                ],
              ];
            })}
          />
          <p className="mt-2 text-xs text-slate-500">
            Shares of resampled paths under this model, not chances for future rounds. A stopped leg
            stakes nothing for the rest of its path; a skipped stake is not a loss.
          </p>
        </section>
      ) : null}
    </>
  );
}

/** The run's sample: what both methods resample. */
export function SamplePanel({ run }: { run: SimulationRunDto }) {
  const report = run.dataset!;
  const summary = run.summary!;
  const money = (v: number) => formatMinorAmount(v, run.settings.currency);
  return (
    <Panel
      title="Sample"
      subtitle="Every eligible round selected by this run's dataset, including any its historical replay did not reach"
    >
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
              {formatPercent(summary.maxDrawdownFraction)} · {STOP_REASON_TEXT[summary.stopReason]}
            </span>,
          ],
        ]}
      />
    </Panel>
  );
}
