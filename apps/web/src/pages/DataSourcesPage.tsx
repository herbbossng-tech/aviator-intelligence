import { Link } from 'react-router';
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
        <Panel title="File import (CSV / JSON)">
          <p className="text-sm text-slate-400">
            Import round histories from files you are permitted to use. Every record is validated
            and previewed before anything is stored; rejected and duplicate records are counted and
            reported, never silently corrected.
          </p>
          <Link
            to="/rounds/import"
            className="mt-3 inline-block text-sm text-sky-400 hover:text-sky-300"
          >
            Import a file
          </Link>
        </Panel>
        <Panel title="Manual entry">
          <p className="text-sm text-slate-400">
            Record rounds you observed yourself, tagged with their source and, when known, their
            event time.
          </p>
          <Link
            to="/rounds/new"
            className="mt-3 inline-block text-sm text-sky-400 hover:text-sky-300"
          >
            Add a round
          </Link>
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
