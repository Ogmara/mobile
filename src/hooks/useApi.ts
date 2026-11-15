/**
 * useApi — lightweight data fetching hook.
 *
 * Wraps an async SDK call with loading/error/data state.
 * Supports manual refetch and pull-to-refresh patterns.
 */

import { useState, useEffect, useCallback, useRef } from 'react';

interface UseApiResult<T> {
  data: T | null;
  loading: boolean;
  error: string | null;
  refetch: () => void;
  refreshing: boolean;
  onRefresh: () => void;
}

/**
 * Fetch data from an async function and manage loading/error state.
 *
 * @param fetcher — async function that returns data
 * @param deps — dependency array (re-fetches when deps change)
 */
export function useApi<T>(
  fetcher: () => Promise<T>,
  deps: unknown[] = [],
): UseApiResult<T> {
  const [data, setData] = useState<T | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [refreshing, setRefreshing] = useState(false);

  // Request generation: only the newest call may write state. Without it a
  // slow response for the PREVIOUS deps (e.g. the previous account's channel
  // list) could land after the current one and replace it.
  const generation = useRef(0);

  const fetch = useCallback(async () => {
    const mine = ++generation.current;
    try {
      setError(null);
      const result = await fetcher();
      if (mine === generation.current) setData(result);
    } catch (e) {
      if (mine === generation.current) setError(e instanceof Error ? e.message : 'Unknown error');
    } finally {
      if (mine === generation.current) {
        setLoading(false);
        setRefreshing(false);
      }
    }
  }, deps);

  useEffect(() => {
    setLoading(true);
    fetch();
  }, [fetch]);

  const refetch = useCallback(() => {
    fetch();
  }, [fetch]);

  const onRefresh = useCallback(() => {
    setRefreshing(true);
    fetch();
  }, [fetch]);

  return { data, loading, error, refetch, refreshing, onRefresh };
}
