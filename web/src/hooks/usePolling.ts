import { useCallback, useEffect, useRef, useState } from 'react';

export type Polling<T> = {
  data: T | null;
  error: unknown;
  loading: boolean;
  refreshing: boolean;
  refresh: () => Promise<void>;
  setData: React.Dispatch<React.SetStateAction<T | null>>;
};

/**
 * Fetch-on-mount with optional interval polling. Aborts in-flight requests on
 * unmount and on dependency change; stale responses are ignored. `loading` is
 * only true for the first fetch, later fetches set `refreshing`.
 */
export function usePolling<T>(
  fetcher: (signal: AbortSignal) => Promise<T>,
  opts: { intervalMs?: number; enabled?: boolean; deps?: readonly unknown[] } = {},
): Polling<T> {
  const { intervalMs = 0, enabled = true } = opts;
  const deps = opts.deps ?? [];

  const [data, setData] = useState<T | null>(null);
  const [error, setError] = useState<unknown>(null);
  const [loading, setLoading] = useState(enabled);
  const [refreshing, setRefreshing] = useState(false);

  const fetcherRef = useRef(fetcher);
  fetcherRef.current = fetcher;
  const ctrlRef = useRef<AbortController | null>(null);
  const loadedRef = useRef(false);

  const run = useCallback(async (background: boolean) => {
    ctrlRef.current?.abort();
    const ctrl = new AbortController();
    ctrlRef.current = ctrl;
    if (background) setRefreshing(true);
    else if (!loadedRef.current) setLoading(true);
    try {
      const result = await fetcherRef.current(ctrl.signal);
      if (ctrl.signal.aborted) return;
      loadedRef.current = true;
      setData(result);
      setError(null);
    } catch (err) {
      if (ctrl.signal.aborted) return;
      if (err instanceof DOMException && err.name === 'AbortError') return;
      setError(err);
    } finally {
      if (!ctrl.signal.aborted) {
        setLoading(false);
        setRefreshing(false);
      }
    }
  }, []);

  // Re-run whenever `enabled` or any caller-supplied dep changes.
  useEffect(() => {
    if (!enabled) {
      setLoading(false);
      return;
    }
    loadedRef.current = false;
    setLoading(true);
    void run(false);
    return () => ctrlRef.current?.abort();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [enabled, run, ...deps]);

  useEffect(() => {
    if (!enabled || intervalMs <= 0) return;
    const id = window.setInterval(() => void run(true), intervalMs);
    return () => window.clearInterval(id);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [enabled, intervalMs, run, ...deps]);

  const refresh = useCallback(() => run(true), [run]);

  return { data, error, loading, refreshing, refresh, setData };
}
