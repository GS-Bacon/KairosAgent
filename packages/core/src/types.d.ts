import { z } from 'zod';
export declare enum RiskLevel {
    LOW = 1,
    MEDIUM = 2,
    HIGH = 3,
    CRITICAL = 4
}
export declare enum TaskStatus {
    PENDING = "pending",
    RUNNING = "running",
    COMPLETED = "completed",
    FAILED = "failed",
    CANCELLED = "cancelled"
}
export declare enum SystemState {
    HEALTHY = "healthy",
    DEGRADED = "degraded",
    SAFE_MODE = "safe_mode",
    STOPPED = "stopped"
}
export declare enum ToolStatus {
    HEALTHY = "healthy",
    DEGRADED = "degraded",
    UNAVAILABLE = "unavailable"
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
export declare const ConfigSchema: z.ZodObject<{
    limits: z.ZodObject<{
        maxLossJPY: z.ZodDefault<z.ZodNumber>;
        maxCpuPercent: z.ZodDefault<z.ZodNumber>;
        maxMemoryMB: z.ZodDefault<z.ZodNumber>;
        maxDiskGB: z.ZodDefault<z.ZodNumber>;
        maxProcesses: z.ZodDefault<z.ZodNumber>;
    }, "strip", z.ZodTypeAny, {
        maxLossJPY: number;
        maxCpuPercent: number;
        maxMemoryMB: number;
        maxDiskGB: number;
        maxProcesses: number;
    }, {
        maxLossJPY?: number | undefined;
        maxCpuPercent?: number | undefined;
        maxMemoryMB?: number | undefined;
        maxDiskGB?: number | undefined;
        maxProcesses?: number | undefined;
    }>;
    intervals: z.ZodObject<{
        healthCheckMs: z.ZodDefault<z.ZodNumber>;
        heartbeatMs: z.ZodDefault<z.ZodNumber>;
        dailyAnalysisHour: z.ZodDefault<z.ZodNumber>;
        backupHour: z.ZodDefault<z.ZodNumber>;
    }, "strip", z.ZodTypeAny, {
        healthCheckMs: number;
        heartbeatMs: number;
        dailyAnalysisHour: number;
        backupHour: number;
    }, {
        healthCheckMs?: number | undefined;
        heartbeatMs?: number | undefined;
        dailyAnalysisHour?: number | undefined;
        backupHour?: number | undefined;
    }>;
    discord: z.ZodObject<{
        webhookUrl: z.ZodOptional<z.ZodString>;
        channelId: z.ZodOptional<z.ZodString>;
    }, "strip", z.ZodTypeAny, {
        webhookUrl?: string | undefined;
        channelId?: string | undefined;
    }, {
        webhookUrl?: string | undefined;
        channelId?: string | undefined;
    }>;
    paths: z.ZodObject<{
        workspace: z.ZodDefault<z.ZodString>;
        backups: z.ZodDefault<z.ZodString>;
        sandbox: z.ZodDefault<z.ZodString>;
        auth: z.ZodDefault<z.ZodString>;
    }, "strip", z.ZodTypeAny, {
        workspace: string;
        backups: string;
        sandbox: string;
        auth: string;
    }, {
        workspace?: string | undefined;
        backups?: string | undefined;
        sandbox?: string | undefined;
        auth?: string | undefined;
    }>;
}, "strip", z.ZodTypeAny, {
    limits: {
        maxLossJPY: number;
        maxCpuPercent: number;
        maxMemoryMB: number;
        maxDiskGB: number;
        maxProcesses: number;
    };
    intervals: {
        healthCheckMs: number;
        heartbeatMs: number;
        dailyAnalysisHour: number;
        backupHour: number;
    };
    discord: {
        webhookUrl?: string | undefined;
        channelId?: string | undefined;
    };
    paths: {
        workspace: string;
        backups: string;
        sandbox: string;
        auth: string;
    };
}, {
    limits: {
        maxLossJPY?: number | undefined;
        maxCpuPercent?: number | undefined;
        maxMemoryMB?: number | undefined;
        maxDiskGB?: number | undefined;
        maxProcesses?: number | undefined;
    };
    intervals: {
        healthCheckMs?: number | undefined;
        heartbeatMs?: number | undefined;
        dailyAnalysisHour?: number | undefined;
        backupHour?: number | undefined;
    };
    discord: {
        webhookUrl?: string | undefined;
        channelId?: string | undefined;
    };
    paths: {
        workspace?: string | undefined;
        backups?: string | undefined;
        sandbox?: string | undefined;
        auth?: string | undefined;
    };
}>;
export type Config = z.infer<typeof ConfigSchema>;
//# sourceMappingURL=types.d.ts.map