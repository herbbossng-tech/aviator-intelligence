import { PageHeader } from '../components/PageHeader';
import { Panel } from '../components/Panel';
import { PlannedBadge } from '../components/PlannedBadge';

export function DataSourcesPage() {
  return (
    <>
      <PageHeader
        title="Data sources"
        description="Where round data comes from, and the rules every source must follow."
      />
      <div className="grid gap-6 md:grid-cols-2">
        <Panel title="File import" actions={<PlannedBadge>Planned</PlannedBadge>}>
          <p className="text-sm text-slate-400">
            Import round histories from files you are permitted to use. Every row will be validated;
            rejected rows will be counted and reported, never silently corrected.
          </p>
        </Panel>
        <Panel title="Manual entry" actions={<PlannedBadge>Planned</PlannedBadge>}>
          <p className="text-sm text-slate-400">
            Record rounds you observed yourself, tagged with their source and observation time.
          </p>
        </Panel>
        <Panel title="Live observation" actions={<PlannedBadge>Not in scope yet</PlannedBadge>}>
          <p className="text-sm text-slate-400">
            Not implemented. Requires a separate review of platform terms, authorised data access,
            technical feasibility and security before any work begins. This app never logs in to
            betting accounts or uses session cookies.
          </p>
        </Panel>
        <Panel title="Provenance principles">
          <ul className="list-disc space-y-1 pl-5 text-sm text-slate-400">
            <li>Every round records its source and when it was observed or imported.</li>
            <li>No data provider is assumed; no round history is generated or invented.</li>
            <li>Synthetic test fixtures are flagged and excluded from all dashboard figures.</li>
          </ul>
        </Panel>
      </div>
    </>
  );
}
