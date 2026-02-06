import { useState, useEffect, useCallback } from 'react';
import { api } from '../client';
import type { CycleSummary, CycleDetail, CycleListResponse } from '../types';

interface UseCyclesResult {
  cycles: CycleSummary[];
  loading: boolean;
  error: string | null;
  refetch: () => void;
}

export function useCycles(): UseCyclesResult {
  const [cycles, setCycles] = useState<CycleSummary[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const fetchCycles = useCallback(async () => {
    setLoading(true);
    setError(null);

    try {
      const response = await api.get<CycleListResponse>('/cycles');
      setCycles(response.data);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to fetch cycles');
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    fetchCycles();
  }, [fetchCycles]);

  return { cycles, loading, error, refetch: fetchCycles };
}

interface UseCycleDetailResult {
  cycle: CycleDetail | null;
  loading: boolean;
  error: string | null;
  refetch: () => void;
}

export function useCycleDetail(cycleId: string | undefined): UseCycleDetailResult {
  const [cycle, setCycle] = useState<CycleDetail | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const fetchCycle = useCallback(async () => {
    if (!cycleId) {
      setCycle(null);
      setLoading(false);
      return;
    }

    setLoading(true);
    setError(null);

    try {
      const response = await api.get<CycleDetail>(`/cycles/${cycleId}`);
      setCycle(response);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to fetch cycle detail');
    } finally {
      setLoading(false);
    }
  }, [cycleId]);

  useEffect(() => {
    fetchCycle();
  }, [fetchCycle]);

  return { cycle, loading, error, refetch: fetchCycle };
}
