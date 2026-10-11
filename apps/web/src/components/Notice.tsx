import type { ReactNode } from 'react';

const TONES = {
  success: 'border-emerald-500/30 bg-emerald-500/10 text-emerald-200',
  warning: 'border-amber-400/30 bg-amber-400/5 text-amber-200',
  info: 'border-sky-500/30 bg-sky-500/5 text-sky-200',
} as const;

export function Notice({ tone, children }: { tone: keyof typeof TONES; children: ReactNode }) {
  return (
    <div role="status" className={`rounded-md border px-4 py-3 text-sm ${TONES[tone]}`}>
      {children}
    </div>
  );
}
