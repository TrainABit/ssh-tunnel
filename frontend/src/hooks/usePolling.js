import { useCallback, useEffect, useRef, useState } from 'react';

const INITIAL = { data: undefined, error: null, loading: true, updatedAt: 0 };

/**
 * Run `loader` now and then every `intervalMs` while the tab is visible.
 *
 * - The last good data is kept when a later request fails (`error` is set instead),
 *   so transient network problems do not blank the page.
 * - Out-of-order responses are ignored; results from a previous `loader`
 *   (e.g. before a filter changed) are discarded.
 * - `loader` must be referentially stable (wrap it in useCallback).
 *
 * @returns {{ data: any, error: Error|null, loading: boolean, updatedAt: number,
 *             refreshing: boolean, refresh: () => Promise<void> }}
 */
export default function usePolling(loader, intervalMs) {
  const [state, setState] = useState(INITIAL);
  const [refreshing, setRefreshing] = useState(false);
  const loaderRef = useRef(loader);
  const runRef = useRef(null); // { active } of the current polling effect
  const requestSeqRef = useRef(0);
  const appliedSeqRef = useRef(0);

  const fetchOnce = useCallback((run) => {
    const seq = ++requestSeqRef.current;
    const isCurrent = () => run.active && seq > appliedSeqRef.current;
    return loaderRef.current().then(
      (data) => {
        if (!isCurrent()) return;
        appliedSeqRef.current = seq;
        setState({ data, error: null, loading: false, updatedAt: Date.now() });
      },
      (error) => {
        if (!isCurrent()) return;
        appliedSeqRef.current = seq;
        setState((prev) => ({ ...prev, error, loading: false }));
      },
    );
  }, []);

  useEffect(() => {
    loaderRef.current = loader;
    const run = { active: true };
    runRef.current = run;
    const isHidden = () => typeof document !== 'undefined' && document.visibilityState === 'hidden';

    fetchOnce(run);
    const timer = setInterval(() => {
      if (!isHidden()) fetchOnce(run);
    }, intervalMs);
    const onVisible = () => {
      if (!isHidden()) fetchOnce(run);
    };
    document.addEventListener('visibilitychange', onVisible);

    return () => {
      clearInterval(timer);
      document.removeEventListener('visibilitychange', onVisible);
      run.active = false;
    };
  }, [loader, intervalMs, fetchOnce]);

  const refresh = useCallback(async () => {
    const run = runRef.current;
    if (!run || !run.active) return;
    setRefreshing(true);
    try {
      await fetchOnce(run);
    } finally {
      setRefreshing(false);
    }
  }, [fetchOnce]);

  return { ...state, refreshing, refresh };
}
