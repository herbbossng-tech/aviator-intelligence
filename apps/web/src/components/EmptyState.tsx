import type { ReactNode } from 'react';

export function EmptyState({ title, children }: { title: string; children: ReactNode }) {
  return (
    <div className="rounded-md border border-dashed border-slate-700 px-6 py-10 text-center">
      <p className="text-sm font-medium text-slate-300">{title}</p>
      <div className="mx-auto mt-2 max-w-md text-sm text-slate-500">{children}</div>
    </div>
  );
}
