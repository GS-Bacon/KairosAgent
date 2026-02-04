import { z } from 'zod';

export enum RiskLevel {
  LOW = 1,
  MEDIUM = 2,
  HIGH = 3,
  CRITICAL = 4,
}

export enum TaskStatus {
  PENDING = 'pending',
  RUNNING = 'running',
  COMPLETED = 'completed',
  FAILED = 'failed',
  CANCELLED = 'cancelled',
}

export enum SystemState {
  HEALTHY = 'healthy',
  DEGRADED = 'degraded',
  SAFE_MODE = 'safe_mode',
  STOPPED = 'stopped',
}

export enum ToolStatus {
  HEALTHY = 'healthy',
  DEGRADED = 'degraded',
  UNAVAILABLE = 'unavailable',
}

export interface Task {
  id: string;
  type: string;
  description: string;
  priority: number;
  status: TaskStatus;
  createdAt: Date;
  startedAt?: Date;
  completedAt?: Date;
  result?: unknown;
  error?: string;
  retryCount: number;
  maxRetries: number;
}

export interface FinancialTransaction {
  id: string;
  timestamp: Date;
  type: 'income' | 'expense' | 'investment';
  amount: number;
  currency: string;
  category: string;
  description: string;
  source?: string;
  metadata?: Record<string, unknown>;
}

export interface AuditEntry {
  timestamp: Date;
  actionId: string;
  actionType: string;
  description: string;
  actor: 'system' | 'ai' | 'human';
  input?: unknown;
  output?: unknown;
  riskLevel: RiskLevel;
  approved: boolean;
  approvedBy?: string;
  financialImpact?: number;
  success: boolean;
  error?: string;
}

export interface ApprovalRequest {
  id: string;
  type: 'action' | 'financial' | 'boundary' | 'strategy';
  title: string;
  description: string;
  riskLevel: RiskLevel;
  requiredApprovals: number;
  approvals: string[];
  rejections: string[];
  createdAt: Date;
  expiresAt: Date;
  status: 'pending' | 'approved' | 'rejected' | 'expired';
  metadata?: Record<string, unknown>;
}

export interface ResourceUsage {
  cpuPercent: number;
  memoryMB: number;
  memoryPercent: number;
  diskGB: number;
  diskPercent: number;
  networkMbps: number;
  processCount: number;
}

export interface ToolHealth {
  claudeCode: ToolStatus;
  browser: ToolStatus;
  network: ToolStatus;
  discord: ToolStatus;
}

export interface SystemHealth {
  state: SystemState;
  uptime: number;
  lastHeartbeat: Date;
  resources: ResourceUsage;
  tools: ToolHealth;
  errors: string[];
  warnings: string[];
}

export const ConfigSchema = z.object({
  limits: z.object({
    maxLossJPY: z.number().default(30000),
    maxCpuPercent: z.number().default(30),
    maxMemoryMB: z.number().default(2048),
    maxDiskGB: z.number().default(10),
    maxProcesses: z.number().default(20),
  }),
  intervals: z.object({
    healthCheckMs: z.number().default(5 * 60 * 1000),
    heartbeatMs: z.number().default(30 * 60 * 1000),
    dailyAnalysisHour: z.number().default(6),
    backupHour: z.number().default(3),
  }),
  discord: z.object({
    webhookUrl: z.string().optional(),
    channelId: z.string().optional(),
  }),
  paths: z.object({
    workspace: z.string().default('/home/bacon/AutoClaudeKMP/workspace'),
    backups: z.string().default('/home/bacon/AutoClaudeKMP/backups'),
    sandbox: z.string().default('/home/bacon/AutoClaudeKMP/sandbox'),
    auth: z.string().default('/home/bacon/AutoClaudeKMP/auth'),
  }),
});

export type Config = z.infer<typeof ConfigSchema>;

// 提案機能の型定義
export type SuggestionCategory = 'feature' | 'bug' | 'improvement' | 'question' | 'other';
export type SuggestionPriority = 'low' | 'medium' | 'high';
export type SuggestionStatus = 'pending' | 'reviewing' | 'accepted' | 'rejected' | 'implemented' | 'deferred';

export interface SuggestionSystemResponse {
  analysis: string;
  decision: string;
  actionPlan?: string;
  respondedAt: Date;
}

export interface Suggestion {
  id: string;
  title: string;
  content: string;
  category: SuggestionCategory;
  priority: SuggestionPriority;
  status: SuggestionStatus;
  createdAt: Date;
  systemResponse?: SuggestionSystemResponse;
}

// レポート機能の型定義
export interface DailyReportActivities {
  tasksCompleted: number;
  strategiesRun: number;
  suggestionsProcessed: number;
}

export interface DailyReportFinancials {
  income: number;
  expense: number;
  net: number;
}

export interface DailyReport {
  date: string;
  generatedAt: Date;
  summary: string;
  activities: DailyReportActivities;
  accomplishments: string[];
  failures: string[];
  improvements: string[];
  financials: DailyReportFinancials;
  healthStatus: string;
}

export interface WeeklyReportTotals {
  tasksCompleted: number;
  strategiesRun: number;
  suggestionsProcessed: number;
  income: number;
  expense: number;
  net: number;
}

export interface WeeklyReport {
  week: string;
  startDate: string;
  endDate: string;
  generatedAt: Date;
  summary: string;
  totals: WeeklyReportTotals;
  highlights: string[];
  challenges: string[];
  learnings: string[];
  dailyReports: string[];
}
