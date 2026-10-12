import { PageHeader } from '../components/PageHeader';
import { Panel } from '../components/Panel';

export function MethodologyPage() {
  return (
    <>
      <PageHeader
        title="Methodology & limits"
        description="What this tool can and cannot tell you."
      />
      <div className="grid gap-6 md:grid-cols-3">
        <Panel title="Historical description">
          <p className="text-sm text-slate-400">
            Summaries of rounds that were recorded. They describe the past and say nothing reliable
            about the next round.
          </p>
        </Panel>
        <Panel title="Simulation">
          <p className="text-sm text-slate-400">
            Replays of a two-leg configuration against recorded rounds, in event-time order, using
            virtual money. A good backtest is not evidence of a future edge. See docs/SIMULATION.md
            for the full method.
          </p>
        </Panel>
        <Panel title="Predictive evidence">
          <p className="text-sm text-slate-400">
            Would require out-of-sample testing with stated uncertainty. None exists in this
            application, and crash-game rounds are designed to be independent.
          </p>
        </Panel>
      </div>
      <div className="mt-6">
        <Panel title="Commitments">
          <ul className="list-disc space-y-1 pl-5 text-sm text-slate-400">
            <li>No strategy is presented as guaranteed or proven to be profitable.</li>
            <li>
              No real-money betting, staking or cashout automation is implemented or planned in this
              phase.
            </li>
            <li>Streaks and patterns in past multipliers are not treated as predictors.</li>
            <li>
              Uncertainty analyses resample a run&apos;s own observations under a stated IID
              bootstrap model. Their figures, including how often paths hit a configured stop, are
              conditional on that model and are not probabilities of real-world loss.
            </li>
            <li>
              Backtest results report drawdown, lowest bankroll, losing streaks and every
              denominator, not totals alone. Risk of ruin is not estimated from a single replay.
            </li>
          </ul>
        </Panel>
      </div>
    </>
  );
}
