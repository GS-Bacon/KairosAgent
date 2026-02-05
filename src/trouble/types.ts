/**
 * Trouble Recording Module - Type Definitions
 *
 * トラブル（ビルドエラー、テスト失敗、名前重複など）を構造化して記録するための型定義
 */

export type TroubleCategory =
  | "build-error"
  | "test-failure"
  | "naming-conflict"
  | "type-error"
  | "runtime-error"
  | "lint-error"
  | "dependency-error"
  | "config-error"
  | "security-issue"
  | "performance-issue"
  | "other";

export type TroubleSeverity = "low" | "medium" | "high" | "critical";

export interface Trouble {
  id: string;
  cycleId: string;
  phase: string;
  category: TroubleCategory;
  severity: TroubleSeverity;
  message: string;
  file?: string;
  line?: number;
  column?: number;
  stackTrace?: string;
  context?: Record<string, unknown>;
  resolved: boolean;
  resolvedBy?: string; // cycleId that resolved this
  occurredAt: string; // ISO date string
  resolvedAt?: string;
}

export interface TroubleInput {
  phase: string;
  category: TroubleCategory;
  severity: TroubleSeverity;
  message: string;
  file?: string;
  line?: number;
  column?: number;
  stackTrace?: string;
  context?: Record<string, unknown>;
}

export interface TroubleStats {
  total: number;
  resolved: number;
  unresolved: number;
  byCategory: Record<TroubleCategory, number>;
  bySeverity: Record<TroubleSeverity, number>;
  byPhase: Record<string, number>;
}

export interface TroubleFilter {
  cycleId?: string;
  phase?: string;
  category?: TroubleCategory;
  severity?: TroubleSeverity;
  resolved?: boolean;
  since?: string; // ISO date string
  until?: string;
  file?: string;
}
