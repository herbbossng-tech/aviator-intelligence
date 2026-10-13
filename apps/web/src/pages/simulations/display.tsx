import type {
  BacktestDatasetReport,
  CurrencyCode,
  LedgerSkipReason,
  ProgressionConfig,
  ProgressionMode,
  SimulationRunDto,
} from '@aviator/shared';
import {
  formatCount,
  formatMinorAmount,
  formatMultiplierX100,
  formatTimestamp,
} from '../../lib/format';

export const BACKTEST_CAUTION =
  'A backtest replays recorded rounds with virtual money. It does not predict future multipliers, and a positive result is not evidence that a configuration will be profitable.';

/** Shown wherever a staking progression is configured or reported. */
export const PROGRESSION_CAUTION =
  'Progression amounts are virtual. Each leg progresses independently from its own results, funded from the bankroll available at the start of the round (leg A first). A leg the bankroll cannot cover is skipped for that round; a skip is not a loss and does not reset or lower its next stake. A step, stake or exposure limit permanently stops that leg. A progression only changes stake sizes: it does not predict rounds or create an edge, and it does not guarantee that losses are recovered.';

export const PROGRESSION_MODE_TEXT: Record<ProgressionMode, string> = {
  fixed: 'Fixed progression',
  martingale: 'Martingale',
  capped_martingale: 'Capped Martingale',
  custom: 'Custom sequence',
};

/** Why a progression leg placed nothing in a round. */
export const SKIP_REASON_TEXT: Record<LedgerSkipReason, string> = {
  insufficient_bankroll: 'the bankroll could not fund the requested stake (not a loss)',
  max_steps_reached: 'step limit reached; leg stopped',
  max_stake_exceeded: 'next stake above the maximum stake; leg stopped',
  cycle_exposure_exceeded: 'next stake above the maximum cycle exposure; leg stopped',
  sequence_exhausted: 'custom sequence exhausted; leg stopped',
};

/** "Martingale ×2.00 · up to 4 steps · max stake ₦… · max cycle exposure ₦…" */
export function describeProgression(config: ProgressionConfig, currency: CurrencyCode): string {
  const money = (v: number) => formatMinorAmount(v, currency);
  const parts: string[] = [PROGRESSION_MODE_TEXT[config.mode]];
  if (config.mode === 'martingale' || config.mode === 'capped_martingale') {
    parts[0] += ` ×${(config.multiplierX100 / 100).toFixed(2)}`;
  }
  if (config.mode === 'custom') {
    parts.push(`stakes ${config.stakesMinor.map(money).join(', ')}`);
  } else {
    parts.push(`base ${money(config.baseStakeMinor)}`);
    parts.push(`up to ${formatCount(config.limits.maxSteps)} step(s)`);
  }
  if (config.limits.maxStakeMinor !== null) {
    parts.push(`max stake ${money(config.limits.maxStakeMinor)}`);
  }
  if (config.limits.maxCycleExposureMinor !== null) {
    parts.push(`max cycle exposure ${money(config.limits.maxCycleExposureMinor)}`);
  }
  return parts.join(' · ');
}

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
        order ambiguous (and event times that are not real instants in the app&apos;s canonical UTC
        form make it unreliable), so the run is refused until the selection is narrowed or the data
        fixed.
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
        A leg may use a staking progression instead of a flat stake. Each leg&apos;s progression
        follows only that leg&apos;s own results. It changes stake sizes only: it cannot predict
        rounds, create an edge or guarantee that losses are recovered, and its limits can stop the
        leg for the rest of the run.
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
    ['Rounds eligible (in replay order)', formatCount(report.roundsEligible)],
    ['Excluded: no event time', formatCount(report.excludedNoEventTime)],
    ['Excluded: synthetic test fixtures', formatCount(report.excludedSynthetic)],
    ['Duplicate event times', formatCount(report.duplicateEventTimes)],
    ['Invalid or non-canonical event times', formatCount(report.nonCanonicalEventTimes)],
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
