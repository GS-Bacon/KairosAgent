import { Goal, GoalProgress } from "../goals/types.js";
import { Trouble } from "../trouble/types.js";

// ========================================
// サイクルタイプシステム（統一ログ用）
// ========================================

/**
 * サイクルタイプの定義
 * 新しいサイクルタイプを追加する場合はここに追加
 */
export type CycleType = "repair" | "research" | "optimize" | "refactor";

/**
 * タイプ別データの基底インターフェース
 */
export interface CycleTypeData {
  type: CycleType;
}

/**
 * リサーチ用データ
 */
export interface ResearchCycleData extends CycleTypeData {
  type: "research";
  topic: {
    id: string;
    topic: string;
    source: string;
    priority: number;
    relatedGoalId?: string;
  };
  findings: Array<{
    source: string;
    summary: string;
    relevance: number;
  }>;
  approaches: Array<{
    id: string;
    description: string;
    pros: string[];
    cons: string[];
    estimatedEffort: string;
    confidence: number;
  }>;
  recommendations: string[];
  queuedImprovements: number;
}

// ========================================
// 既存の型定義
// ========================================

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
  source?: "queue" | "marker" | "pattern" | "goal";  // 改善の出所
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

  // 統一サイクルログ用: タイプ別データ
  cycleData?: CycleTypeData;
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
 * フルCycleContextを作成する
 * orchestrator.tsで初期化が散在していたフィールドを一箇所で初期化
 * これにより初期化漏れやnullアクセスエラーを防止
 */
export function createFullCycleContext(options?: {
  activeGoals?: Goal[];
  cycleId?: string;
}): CycleContext {
  return {
    cycleId: options?.cycleId || `cycle_${Date.now()}`,
    startTime: new Date(),
    issues: [],
    improvements: [],
    // Goal context
    activeGoals: options?.activeGoals || [],
    goalProgress: [],
    // Learning system fields
    usedPatterns: [],
    patternMatches: 0,
    aiCalls: 0,
    // Trouble tracking
    troubles: [],
    // Token usage (populated during cycle)
    tokenUsage: undefined,
    // Failure tracking (populated on failure)
    failedPhase: undefined,
    failureReason: undefined,
    // Implementation tracking (populated during implement phase)
    implementedChanges: undefined,
    testResults: undefined,
    searchResults: undefined,
    plan: undefined,
    snapshotId: undefined,
    // Cycle type data (populated for specialized cycles like research)
    cycleData: undefined,
  };
}

/**
 * サイクル実行結果
 * Orchestratorが返す、スケジューラーが即時再実行判断に使用
 */
export type CycleQuality = "effective" | "no-op" | "partial" | "failed";

export interface CycleResult {
  cycleId: string;
  success: boolean;
  duration: number;
  troubleCount: number;
  shouldRetry: boolean;      // 即時再実行が必要か
  retryReason?: string;      // 再実行理由
  failedPhase?: string;      // 失敗したフェーズ名
  skippedEarly?: boolean;    // 作業がなく早期終了したか
  quality?: CycleQuality;    // サイクルの品質メトリクス
}
