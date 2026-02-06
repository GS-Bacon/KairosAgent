import { useState, useEffect, useCallback } from 'react';
import { api } from '../client';
import type { StatusResponse } from '../types';

interface UseStatusResult {
  status: StatusResponse | null;
  loading: boolean;
  error: string | null;
  refetch: () => void;
}

export function useStatus(): UseStatusResult {
  const [status, setStatus] = useState<StatusResponse | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const fetchStatus = useCallback(async () => {
    setLoading(true);
    setError(null);

    try {
      const response = await api.get<StatusResponse>('/status');
      setStatus(response);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to fetch status');
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    fetchStatus();

    // Auto-refresh every 30 seconds
    const interval = setInterval(fetchStatus, 30000);
    return () => clearInterval(interval);
  }, [fetchStatus]);

  return { status, loading, error, refetch: fetchStatus };
}
