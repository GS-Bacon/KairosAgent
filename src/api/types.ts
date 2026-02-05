export interface CriticalAlertInfo {
  type: string;
  message: string;
  timestamp: string;
  affectedProviders?: string[];
}

export interface ProviderHealthInfo {
  name: string;
  status: "healthy" | "degraded" | "broken";
  consecutiveFailures: number;
  lastSuccess?: string;
  lastFailure?: string;
}

export interface StatusResponse {
  state: "running" | "idle" | "error" | "critical";
  uptime_seconds: number;
  last_check?: string;
  stats: {
    modifications_7d: number;
    rollbacks_7d: number;
    errors_7d: number;
  };
  next_check?: string;
  criticalAlerts?: CriticalAlertInfo[];
  providerHealth?: ProviderHealthInfo[];
}

export interface HealthResponse {
  status: "healthy" | "degraded" | "unhealthy";
  checks: Array<{
    name: string;
    status: "pass" | "fail" | "warn";
    message?: string;
  }>;
  timestamp: string;
}

export interface LogEntry {
  timestamp: string;
  level: string;
  message: string;
}

export interface HistoryEntry {
  id: string;
  timestamp: string;
  type: "modification" | "rollback" | "error";
  description: string;
  files?: string[];
}

export interface TriggerResponse {
  success: boolean;
  message: string;
  cycleId?: string;
}

export interface ConfigResponse {
  ai: {
    provider: string;
  };
  scheduler: {
    interval: number;
    retryState?: {
      consecutiveFailures: number;
      maxRetries: number;
      lastFailureReason?: string;
      cooldownUntil?: Date;
    };
  };
  safety: {
    maxFilesPerChange: number;
    protectedPatterns: string[];
  };
}
