import type { BacktestDatasetReport, CurrencyCode, SimulationRunDto } from '@aviator/shared';
import {
  formatCount,
  formatMinorAmount,
  formatMultiplierX100,
  formatTimestamp,
} from '../../lib/format';

export const BACKTEST_CAUTION =
  'A backtest replays recorded rounds with virtual money. It does not predict future multipliers, and a positive result is not evidence that a configuration will be profitable.';

/** Signed money, e.g. +₦12.00 / -₦3.50. */
export function formatSignedMinor(amountMinor: number, currency: CurrencyCode): string {
  return amountMinor > 0
    ? `+${formatMinorAmount(amountMinor, currency)}`
    : formatMinorAmount(amountMinor, currency);
}

export function signedPercent(fraction: number): string {
  const text = `${(fraction * 100).toFixed(2)}%`;
  return fraction > 0 ? `+${text}` : text;
}

/** "Leg A 2.00x @ ₦500.00 · Leg B off" */
export function describeLegs(run: Pick<SimulationRunDto, 'strategy'>): string {
  const { legs, currency } = run.strategy;
  return (['A', 'B'] as const)
    .map((k) =>
      legs[k].enabled
        ? `${k}: ${formatMultiplierX100(legs[k].cashoutTargetX100)} @ ${formatMinorAmount(legs[k].stakeMinor, currency)}`
        : `${k}: off`,
    )
    .join(' · ');
}

export function describeDatasetRequest(dataset: SimulationRunDto['datasetRequest']): string {
  const parts = [dataset.source];
  if (dataset.importId !== null) parts.push(`import #${dataset.importId}`);
  if (dataset.eventFrom !== null || dataset.eventTo !== null) {
    parts.push(`${dataset.eventFrom ?? 'start'} → ${dataset.eventTo ?? 'end'}`);
  }
  return parts.join(' · ');
}

/** The modelling assumptions every backtest uses. Shown before running and with each result. */
export function AssumptionsList() {
  return (
    <ul className="list-disc space-y-1 pl-5 text-sm text-slate-400">
      <li>Virtual money only. Nothing is placed, staked or cashed out anywhere.</li>
      <li>
        Rounds come from one source and are replayed in event-time order. Rounds without an event
        time, and synthetic test fixtures, are excluded and counted. Duplicate event times make the
        order ambiguous (and event times not stored in the app&apos;s canonical UTC form make it
        unreliable), so the run is refused until the selection is narrowed or the data fixed.
      </li>
      <li>
        Each round, every enabled leg is staked from the bankroll available at the start of that
        round (leg A first, then B).
      </li>
      <li>
        A leg reaches its target when the round&apos;s crash multiplier is at or above the target
        (an assumption to be confirmed against the platform&apos;s published rules). It then returns
        stake × target, rounded down to the minor unit; otherwise the stake is lost.
      </li>
      <li>
        <strong className="font-medium text-slate-300">Returned</strong> is the gross amount paid
        back on successful cashouts, including the stake.{' '}
        <strong className="font-medium text-slate-300">Net</strong> = returned − staked.
      </li>
      <li>
        Decisions use only the configuration and the bankroll so far; a round&apos;s multiplier is
        used only to settle that round (no look-ahead). Multiplier filters are not offered for the
        same reason.
      </li>
      <li>
        If the bankroll cannot cover a stake, the chosen policy either skips that leg for the round
        (recorded as skipped, zero stake) or stops the run. Stops are checked after each round.
      </li>
      <li>
        Risk of ruin is not estimated: a single historical path cannot support a defensible
        probability. Maximum drawdown and lowest bankroll describe this replay only.
      </li>
      <li>
        Max drawdown is reported two ways: the largest fall in money from a running peak, and the
        largest fall relative to its running peak. They can come from different episodes.
      </li>
    </ul>
  );
}

export function DatasetReportView({ report }: { report: BacktestDatasetReport }) {
  const rows: [string, string][] = [
    ['Source', report.dataset.source],
    ['Import', report.dataset.importId === null ? 'Any' : `#${report.dataset.importId}`],
    [
      'Event-time range',
      `${report.dataset.eventFrom ?? 'start'} → ${report.dataset.eventTo ?? 'end'} (from inclusive, to exclusive)`,
    ],
    ['Rounds eligible (replayed in order)', formatCount(report.roundsEligible)],
    ['Excluded: no event time', formatCount(report.excludedNoEventTime)],
    ['Excluded: synthetic test fixtures', formatCount(report.excludedSynthetic)],
    ['Duplicate event times', formatCount(report.duplicateEventTimes)],
    ['Non-canonical event times', formatCount(report.nonCanonicalEventTimes)],
    ['First event', formatTimestamp(report.firstEventAt)],
    ['Last event', formatTimestamp(report.lastEventAt)],
    ['Ordering rule', report.orderingRule],
    ['Maximum rounds per backtest', formatCount(report.maxRounds)],
  ];
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
