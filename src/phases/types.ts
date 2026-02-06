import { Goal, GoalProgress } from "../goals/types.js";
import { Trouble } from "../trouble/types.js";

export interface Issue {
  id: string;
  type: "error" | "warning" | "critical";
  source: string;
  message: string;
  file?: string;
  line?: number;
  timestamp: Date;
  // 追加フィールド: 詳細な問題追跡
  detectedProblem?: string;  // 何を検出したか（要約）
  resolution?: string;        // どう対処したか
  resolved?: boolean;         // 解決済みか
}

export interface Improvement {
  id: string;
  type: "todo" | "fixme" | "optimization" | "refactor" | "security" | "tool-adoption";
  description: string;
  file: string;
  line?: number;
  priority: "low" | "medium" | "high";
}

export interface SearchResult {
  query: string;
  findings: Array<{
    file: string;
    content: string;
    relevance: number;
  }>;
  analysis?: string;
}

export interface RepairPlan {
  id: string;
  targetIssue?: Issue;
  targetImprovement?: Improvement;
  description: string;
  steps: Array<{
    order: number;
    action: string;
    file: string;
    details: string;
  }>;
  estimatedRisk: "low" | "medium" | "high";
  affectedFiles: string[];
}

export interface PhaseResult {
  success: boolean;
  shouldStop: boolean;
  message?: string;
  data?: unknown;
}

export interface CycleContext {
  cycleId: string;
  startTime: Date;
  issues: Issue[];
  improvements: Improvement[];
  searchResults?: SearchResult;
  plan?: RepairPlan;
  snapshotId?: string;
  implementedChanges?: Array<{
    file: string;
    changeType: "create" | "modify" | "delete";
    // 追加フィールド: 変更詳細
    summary?: string;       // 変更内容の要約（1-2行）
    relatedIssue?: string;  // 関連するIssue ID
  }>;
  testResults?: {
    passed: boolean;
    totalTests: number;
    passedTests: number;
    failedTests: number;
    errors: string[];
  };
  activeGoals?: Goal[];
  goalProgress?: GoalProgress[];

  // Learning system fields
  usedPatterns?: string[];  // パターンIDのリスト
  patternMatches?: number;  // パターンマッチの数
  aiCalls?: number;         // AI呼び出しの数

  // Trouble tracking
  troubles?: Trouble[];     // サイクル中に発生したトラブル

  // Failure tracking（失敗追跡）
  failedPhase?: string;      // 失敗したフェーズ名
  failureReason?: string;    // 失敗理由の要約

  // Token usage tracking
  tokenUsage?: {
    totalInput: number;
    totalOutput: number;
    byPhase: Record<string, { input: number; output: number }>;
    byProvider: Record<string, { input: number; output: number }>;
  };
}

export interface Phase {
  name: string;
  execute(context: CycleContext): Promise<PhaseResult>;
}

export function createCycleContext(): CycleContext {
  return {
    cycleId: `cycle_${Date.now()}`,
    startTime: new Date(),
    issues: [],
    improvements: [],
  };
}

/**
 * サイクル実行結果
 * Orchestratorが返す、スケジューラーが即時再実行判断に使用
 */
export interface CycleResult {
  cycleId: string;
  success: boolean;
  duration: number;
  troubleCount: number;
  shouldRetry: boolean;      // 即時再実行が必要か
  retryReason?: string;      // 再実行理由
  failedPhase?: string;      // 失敗したフェーズ名
  skippedEarly?: boolean;    // 作業がなく早期終了したか
}
