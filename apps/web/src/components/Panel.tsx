import type { ReactNode } from 'react';

export function Panel({
  title,
  subtitle,
  actions,
  children,
}: {
  title: string;
  subtitle?: string;
  actions?: ReactNode;
  children: ReactNode;
}) {
  return (
    <section
      className="min-w-0 rounded-lg border border-slate-800 bg-slate-900/40"
      aria-label={title}
    >
      <div className="flex flex-wrap items-start justify-between gap-2 border-b border-slate-800 px-5 py-3">
        <div>
          <h2 className="text-sm font-medium text-slate-200">{title}</h2>
          {subtitle ? <p className="mt-0.5 text-xs text-slate-500">{subtitle}</p> : null}
        </div>
        {actions}
      </div>
      <div className="p-5">{children}</div>
    </section>
  );
}
