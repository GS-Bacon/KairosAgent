export interface StatusResponse {
  state: "running" | "idle" | "error";
  uptime_seconds: number;
  last_check?: string;
  stats: {
    modifications_7d: number;
    rollbacks_7d: number;
    errors_7d: number;
  };
  next_check?: string;
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
  };
  safety: {
    maxFilesPerChange: number;
    protectedPatterns: string[];
  };
}
