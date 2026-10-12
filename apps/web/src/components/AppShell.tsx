import { NavLink, Outlet } from 'react-router';
import { ApiStatus } from './ApiStatus';
import { ResearchModeBadge } from './ResearchModeBadge';

const NAV_ITEMS = [
  { to: '/', label: 'Overview', end: true },
  { to: '/rounds', label: 'Round history' },
  { to: '/strategy-lab', label: 'Strategy lab' },
  { to: '/simulations', label: 'Simulations' },
  { to: '/data-sources', label: 'Data sources' },
  { to: '/methodology', label: 'Methodology & limits' },
] as const;

export function AppShell() {
  return (
    <div className="min-h-screen lg:grid lg:grid-cols-[15rem_1fr]">
      <aside className="border-b border-slate-800 bg-slate-900/60 lg:sticky lg:top-0 lg:h-screen lg:border-r lg:border-b-0">
        <div className="flex items-center gap-3 px-5 py-5">
          <div
            aria-hidden="true"
            className="grid h-9 w-9 place-items-center rounded-md bg-sky-500/15 font-mono text-sm font-semibold text-sky-300 ring-1 ring-sky-500/30"
          >
            AI
          </div>
          <div>
            <p className="text-sm font-semibold tracking-tight text-slate-100">
              Aviator Intelligence
            </p>
            <p className="text-xs text-slate-500">Research workbench</p>
          </div>
        </div>
        <nav
          aria-label="Primary"
          className="flex gap-1 overflow-x-auto px-3 pb-3 lg:flex-col lg:overflow-visible"
        >
          {NAV_ITEMS.map((item) => (
            <NavLink
              key={item.to}
              to={item.to}
              end={'end' in item}
              className={({ isActive }) =>
                `rounded-md px-3 py-2 text-sm whitespace-nowrap transition-colors ${
                  isActive
                    ? 'bg-slate-800 text-slate-100'
                    : 'text-slate-400 hover:bg-slate-800/60 hover:text-slate-200'
                }`
              }
            >
              {item.label}
            </NavLink>
          ))}
        </nav>
      </aside>
      <div className="flex min-w-0 flex-col">
        <header className="flex flex-wrap items-center justify-between gap-3 border-b border-slate-800 px-4 py-3 sm:px-8">
          <ResearchModeBadge />
          <ApiStatus />
        </header>
        <main className="flex-1 px-4 py-6 sm:px-8 sm:py-8">
          <Outlet />
        </main>
        <footer className="border-t border-slate-800 px-4 py-4 text-xs text-slate-500 sm:px-8">
          Research and simulation only. All bankroll figures are virtual. Past rounds do not predict
          future rounds, and no strategy shown here is claimed to be profitable.
        </footer>
      </div>
    </div>
  );
}
