import type { ReactNode } from 'react';

export const inputClass =
  'w-full rounded-md border border-slate-700 bg-slate-950 px-3 py-2 text-sm text-slate-100 placeholder:text-slate-600 focus:border-sky-500 focus:outline-none focus:ring-1 focus:ring-sky-500 aria-[invalid=true]:border-rose-500';

/** Label + control + hint + error, wired together for screen readers. */
export function FormField({
  id,
  label,
  hint,
  error,
  required = false,
  children,
}: {
  id: string;
  label: string;
  hint?: string;
  error?: string | undefined;
  required?: boolean;
  children: (props: {
    id: string;
    'aria-describedby': string | undefined;
    'aria-invalid': boolean;
  }) => ReactNode;
}) {
  const describedBy = [hint ? `${id}-hint` : null, error ? `${id}-error` : null]
    .filter(Boolean)
    .join(' ');
  return (
    <div>
      <label htmlFor={id} className="mb-1 block text-xs font-medium text-slate-300">
        {label}
        {required ? (
          <span className="text-rose-400"> *</span>
        ) : (
          <span className="text-slate-500"> (optional)</span>
        )}
      </label>
      {children({
        id,
        'aria-describedby': describedBy || undefined,
        'aria-invalid': Boolean(error),
      })}
      {hint ? (
        <p id={`${id}-hint`} className="mt-1 text-xs text-slate-500">
          {hint}
        </p>
      ) : null}
      {error ? (
        <p id={`${id}-error`} className="mt-1 text-xs text-rose-300">
          {error}
        </p>
      ) : null}
    </div>
  );
}
