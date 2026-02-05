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
}
