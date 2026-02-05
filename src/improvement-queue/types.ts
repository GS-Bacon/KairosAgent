/**
 * Improvement Queue - Type Definitions
 *
 * 改善提案をキューで管理するための型定義
 */

export type ImprovementSource =
  | "phase-health-check"
  | "phase-error-detect"
  | "phase-improve-find"
  | "phase-search"
  | "phase-plan"
  | "phase-implement"
  | "phase-test-gen"
  | "phase-verify"
  | "trouble-abstraction"
  | "manual";

export type ImprovementStatus =
  | "pending"
  | "scheduled"
  | "in_progress"
  | "completed"
  | "failed"
  | "skipped";

export type ImprovementType =
  | "bug-fix"
  | "feature"
  | "refactor"
  | "prevention"
  | "documentation"
  | "tooling"
  | "testing"
  | "security"
  | "performance";

export interface QueuedImprovement {
  id: string;
  source: ImprovementSource;
  type: ImprovementType;
  title: string;
  description: string;
  priority: number; // 0-100, higher is more important
  status: ImprovementStatus;
  metadata?: Record<string, unknown>;

  // 関連情報
  relatedFile?: string;
  relatedTroubleIds?: string[];
  relatedPatternId?: string;
  preventionSuggestionId?: string;

  // タイムスタンプ
  createdAt: string;
  updatedAt: string;
  scheduledFor?: string; // 次のサイクルで処理予定
  completedAt?: string;

  // 処理結果
  cycleId?: string; // 処理したサイクルID
  result?: {
    success: boolean;
    message?: string;
    commitHash?: string;
  };
}

export interface QueuedImprovementInput {
  source: ImprovementSource;
  type: ImprovementType;
  title: string;
  description: string;
  priority?: number;
  metadata?: Record<string, unknown>;
  relatedFile?: string;
  relatedTroubleIds?: string[];
  relatedPatternId?: string;
  preventionSuggestionId?: string;
}

export interface QueueStore {
  version: number;
  queue: QueuedImprovement[];
  lastUpdated: string;
}

export interface QueueStats {
  total: number;
  byStatus: Record<ImprovementStatus, number>;
  bySource: Record<string, number>;
  byType: Record<string, number>;
  avgPriority: number;
}

export interface QueueFilter {
  status?: ImprovementStatus;
  source?: ImprovementSource;
  type?: ImprovementType;
  minPriority?: number;
  maxPriority?: number;
  relatedPatternId?: string;
  since?: string;
  until?: string;
}
