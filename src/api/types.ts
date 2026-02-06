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
    modifications_30d: number;
    rollbacks_30d: number;
    errors_30d: number;
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

export interface MarkdownLogFile {
  filename: string;
  date: string;
  topic: string;
  path: string;
  size: number;
  mtime: string;
}

export interface MarkdownLogListResponse {
  count: number;
  data: MarkdownLogFile[];
}

export interface MarkdownLogContentResponse {
  filename: string;
  content: string;
  size: number;
  mtime: string;
}

// Cycle types
export interface CycleIssue {
  type: "error" | "warn" | "info";
  message: string;
  context?: string;
}

export interface CycleChange {
  file: string;
  changeType: "create" | "modify" | "delete";
}

export interface CycleTrouble {
  type: string;
  message: string;
}

export interface CycleSummary {
  cycleId: string;
  filename: string;
  date: string;
  startTime: string;
  endTime?: string;
  duration: number;
  success: boolean;
  issueCount: number;
  changeCount: number;
  troubleCount: number;
  cycleType?: "repair" | "research";  // サイクルの種類
  researchTopic?: string;             // リサーチの場合のトピック
  findingsCount?: number;             // リサーチの場合の発見数
  approachesCount?: number;           // リサーチの場合のアプローチ数
}

export interface CycleDetail {
  cycleId: string;
  filename: string;
  startTime: string;
  endTime?: string;
  duration: number;
  success: boolean;
  issues: CycleIssue[];
  changes: CycleChange[];
  troubles: CycleTrouble[];
  tokenUsage?: { input: number; output: number };
  rawContent: string;
}

export interface CycleListResponse {
  count: number;
  data: CycleSummary[];
}

export interface CycleDetailResponse extends CycleDetail {}
