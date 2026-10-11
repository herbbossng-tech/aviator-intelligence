export function PlannedBadge({ children = 'Not implemented yet' }: { children?: string }) {
  return (
    <span className="rounded-full bg-slate-800 px-2 py-0.5 text-[11px] font-medium text-slate-400 ring-1 ring-slate-700">
      {children}
    </span>
  );
}
