import { useState, useEffect, useCallback } from 'react';
import { api } from '../client';

// Types
export interface QueuedImprovement {
  id: string;
  title: string;
  description: string;
  type: string;
  source: string;
  status: 'pending' | 'scheduled' | 'in_progress' | 'completed' | 'failed' | 'skipped';
  priority: number;
  relatedFile?: string;
  createdAt: string;
  updatedAt: string;
}

export interface ImprovementQueueResponse {
  count: number;
  data: QueuedImprovement[];
}

export interface ImprovementQueueStats {
  total: number;
  byStatus: {
    pending: number;
    inProgress: number;
    completed: number;
    failed: number;
    skipped: number;
  };
  byType: Record<string, number>;
  bySource: Record<string, number>;
  avgPriority: number;
}

export interface ConfirmationItem {
  id: string;
  changeId: string;
  status: 'pending' | 'in_review' | 'confirmed' | 'rejected' | 'needs_review';
  priority: number;
  createdAt: string;
  reviewedAt?: string;
  reviewNotes?: string;
}

export interface ConfirmationQueueResponse {
  count: number;
  stats: {
    total: number;
    pending: number;
    inReview: number;
    confirmed: number;
    rejected: number;
    needsReview: number;
  };
  data: ConfirmationItem[];
}

export interface GLMChange {
  id: string;
  timestamp: string;
  phase: string;
  files: string[];
  description: string;
  reviewed: boolean;
  approved?: boolean;
  confirmationStatus?: string;
}

export interface GLMChangesResponse {
  count: number;
  stats: {
    total: number;
    unreviewed: number;
    approved: number;
    rejected: number;
    byPhase: Record<string, number>;
  };
  data: GLMChange[];
}

// Hooks
export function useImprovementQueue() {
  const [data, setData] = useState<QueuedImprovement[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const refetch = useCallback(async () => {
    try {
      setLoading(true);
      const response = await api.get<ImprovementQueueResponse>('/queues/improvements');
      setData(response.data);
      setError(null);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to fetch improvement queue');
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    refetch();
  }, [refetch]);

  return { data, loading, error, refetch };
}

export function useImprovementQueueStats() {
  const [stats, setStats] = useState<ImprovementQueueStats | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    async function fetch() {
      try {
        const response = await api.get<ImprovementQueueStats>('/queues/improvements/stats');
        setStats(response);
        setError(null);
      } catch (err) {
        setError(err instanceof Error ? err.message : 'Failed to fetch stats');
      } finally {
        setLoading(false);
      }
    }
    fetch();
  }, []);

  return { stats, loading, error };
}

export function useConfirmationQueue() {
  const [data, setData] = useState<ConfirmationItem[]>([]);
  const [stats, setStats] = useState<ConfirmationQueueResponse['stats'] | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const refetch = useCallback(async () => {
    try {
      setLoading(true);
      const response = await api.get<ConfirmationQueueResponse>('/queues/confirmations');
      setData(response.data);
      setStats(response.stats);
      setError(null);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to fetch confirmation queue');
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    refetch();
  }, [refetch]);

  return { data, stats, loading, error, refetch };
}

export function useGLMChanges() {
  const [data, setData] = useState<GLMChange[]>([]);
  const [stats, setStats] = useState<GLMChangesResponse['stats'] | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const refetch = useCallback(async () => {
    try {
      setLoading(true);
      const response = await api.get<GLMChangesResponse>('/queues/glm-changes');
      setData(response.data);
      setStats(response.stats);
      setError(null);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to fetch GLM changes');
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    refetch();
  }, [refetch]);

  return { data, stats, loading, error, refetch };
}
