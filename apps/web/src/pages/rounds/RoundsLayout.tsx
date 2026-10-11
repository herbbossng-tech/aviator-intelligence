import { NavLink, Outlet } from 'react-router';
import { PageHeader } from '../../components/PageHeader';

const TABS = [
  { to: '/rounds', label: 'Browse', end: true },
  { to: '/rounds/new', label: 'Add a round' },
  { to: '/rounds/import', label: 'Import file' },
  { to: '/rounds/imports', label: 'Import history' },
] as const;

export function RoundsLayout() {
  return (
    <>
      <PageHeader
        title="Round data"
        description="Historical crash multipliers with their source and provenance. This is a record of the past; it is not used to predict upcoming rounds."
      />
      <nav
        aria-label="Round data sections"
        className="mb-6 flex gap-1 overflow-x-auto border-b border-slate-800"
      >
        {TABS.map((tab) => (
          <NavLink
            key={tab.to}
            to={tab.to}
            end={'end' in tab}
            className={({ isActive }) =>
              `-mb-px border-b-2 px-3 py-2 text-sm whitespace-nowrap ${
                isActive
                  ? 'border-sky-400 text-slate-100'
                  : 'border-transparent text-slate-400 hover:text-slate-200'
              }`
            }
          >
            {tab.label}
          </NavLink>
        ))}
      </nav>
      <Outlet />
    </>
  );
}
