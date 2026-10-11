import { PageHeader } from '../components/PageHeader';
import { Panel } from '../components/Panel';
import { PlannedBadge } from '../components/PlannedBadge';
import { EmptyState } from '../components/EmptyState';

export function SimulationsPage() {
  return (
    <>
      <PageHeader
        title="Simulations"
        description="Reproducible virtual backtests of two-leg configurations against recorded rounds, with a persistent virtual ledger."
      >
        <PlannedBadge />
      </PageHeader>
      <Panel title="Simulation runs">
        <EmptyState title="The simulation engine is not implemented yet">
          The database schema for simulation runs and the virtual ledger exists, but no engine runs
          simulations yet. When it does, results will report variance, drawdown and uncertainty
          alongside any totals.
        </EmptyState>
      </Panel>
    </>
  );
}
