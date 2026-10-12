import {
  SAMPLE_TWO_LEG_CONFIG,
  twoLegStrategyConfigSchema,
  type LegConfig,
  type LegKey,
} from '@aviator/shared';
import { PageHeader } from '../components/PageHeader';
import { Panel } from '../components/Panel';
import { PlannedBadge } from '../components/PlannedBadge';
import { formatMinorAmount, formatMultiplierX100 } from '../lib/format';

export function StrategyLabPage() {
  // Validate the sample with the same schema future user-defined strategies will use.
  const sample = twoLegStrategyConfigSchema.parse(SAMPLE_TWO_LEG_CONFIG);

  return (
    <>
      <PageHeader
        title="Strategy lab"
        description="Configure two independent virtual legs for simulation and comparison. Configuring legs places no bets and does not make a strategy profitable."
      >
        <PlannedBadge>Editor and simulator: planned</PlannedBadge>
      </PageHeader>

      <div
        role="note"
        className="mb-6 rounded-md border border-amber-400/30 bg-amber-400/5 px-4 py-3 text-sm text-amber-200"
      >
        <strong className="font-medium">Sample configuration.</strong> The values below only
        illustrate the configuration format. They are not recommended stakes or targets and have not
        been tested or proven.
      </div>

      <div className="grid gap-6 md:grid-cols-2">
        {(Object.keys(sample.legs) as LegKey[]).map((key) => (
          <LegCard key={key} legKey={key} leg={sample.legs[key]} currency={sample.currency} />
        ))}
      </div>

      <div className="mt-6">
        <Panel
          title="How a leg will be settled in simulation"
          subtitle="Accounting rule, not a forecast"
        >
          <ul className="list-disc space-y-1 pl-5 text-sm text-slate-400">
            <li>
              A leg is treated as cashed out when the round&apos;s crash multiplier is at or above
              its target (an assumption to be confirmed against the platform&apos;s published
              rules).
            </li>
            <li>
              Winning gross return = stake × target, rounded down to the nearest minor currency
              unit.
            </li>
            <li>A losing leg returns nothing; the stake is the net loss.</li>
            <li>All amounts are integers in minor units (e.g. kobo) and are virtual.</li>
          </ul>
        </Panel>
      </div>
    </>
  );
}

function LegCard({
  legKey,
  leg,
  currency,
}: {
  legKey: LegKey;
  leg: LegConfig;
  currency: typeof SAMPLE_TWO_LEG_CONFIG.currency;
}) {
  return (
    <Panel
      title={leg.label}
      subtitle={`Leg ${legKey}`}
      actions={<PlannedBadge>Sample</PlannedBadge>}
    >
      <dl className="grid grid-cols-3 gap-4 text-sm">
        <div>
          <dt className="text-xs text-slate-500">Status</dt>
          <dd className="mt-1 text-slate-200">{leg.enabled ? 'Enabled' : 'Disabled'}</dd>
        </div>
        <div>
          <dt className="text-xs text-slate-500">Virtual stake</dt>
          <dd className="mt-1 font-mono tabular-nums text-slate-200">
            {formatMinorAmount(leg.stakeMinor, currency)}
          </dd>
        </div>
        <div>
          <dt className="text-xs text-slate-500">Cashout target</dt>
          <dd className="mt-1 font-mono tabular-nums text-slate-200">
            {formatMultiplierX100(leg.cashoutTargetX100)}
          </dd>
        </div>
      </dl>
    </Panel>
  );
}
