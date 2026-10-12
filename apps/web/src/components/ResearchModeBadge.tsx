export function ResearchModeBadge() {
  return (
    <div className="flex items-center gap-2" role="status" aria-label="Application mode">
      <span className="rounded-full bg-amber-400/10 px-2.5 py-1 text-xs font-medium text-amber-300 ring-1 ring-amber-400/30">
        Research &amp; simulation mode
      </span>
      <span className="hidden text-xs text-slate-500 sm:inline">
        No real-money execution · No live data connected
      </span>
    </div>
  );
}
