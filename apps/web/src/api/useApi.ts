import { useEffect, useState } from 'react';

export type ApiState<T> =
  { status: 'loading' } | { status: 'error'; message: string } | { status: 'success'; data: T };

const LOADING = { status: 'loading' } as const;

/**
 * Runs an API loader on mount and whenever `deps` change, cancelling stale requests.
 * Results are tagged with the deps they were loaded for, so a change of deps reads as
 * "loading" immediately without a synchronous setState inside the effect.
 */
export function useApi<T>(
  loader: (signal: AbortSignal) => Promise<T>,
  deps: readonly unknown[] = [],
): ApiState<T> {
  const key = JSON.stringify(deps);
  const [result, setResult] = useState<{ key: string; state: ApiState<T> } | null>(null);

  useEffect(() => {
    const controller = new AbortController();
    loader(controller.signal).then(
      (data) => {
        if (!controller.signal.aborted) setResult({ key, state: { status: 'success', data } });
      },
      (error: unknown) => {
        if (controller.signal.aborted) return;
        const message = error instanceof Error ? error.message : 'Unknown error';
        setResult({ key, state: { status: 'error', message } });
      },
    );
    return () => controller.abort();
    // eslint-disable-next-line react-hooks/exhaustive-deps -- reloads are keyed on the caller's explicit deps
  }, [key]);

  return result !== null && result.key === key ? result.state : LOADING;
}
