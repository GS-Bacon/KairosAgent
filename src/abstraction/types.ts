/**
 * Abstraction Engine - Type Definitions
 *
 * トラブルの抽象化と予防策生成のための型定義
 */

import { Trouble, TroubleCategory } from "../trouble/types.js";

export type PreventionType =
  | "naming-convention"
  | "lint-rule"
  | "pre-commit"
  | "architecture"
  | "testing"
  | "documentation"
  | "tooling"
  | "process";

export interface PreventionSuggestion {
  id: string;
  type: PreventionType;
  description: string;
  implementation?: string; // 具体的な実装方法
  automated: boolean; // 自動化可能か
  confidence: number; // 0-1
  appliedAt?: string; // ISO date string
}

export interface TroublePattern {
  id: string;
  name: string; // 例: "duplicate-function-names"
  description: string;
  category: TroubleCategory;
  keywords: string[]; // マッチング用キーワード
  regex?: string; // オプショナルな正規表現パターン
  occurrenceCount: number;
  troubleIds: string[]; // このパターンに紐づくトラブルID
  preventionSuggestions: PreventionSuggestion[];
  confidence: number; // パターンの信頼度 0-1
  createdAt: string;
  updatedAt: string;
  lastOccurredAt: string;
}

export interface PatternStore {
  version: number;
  patterns: TroublePattern[];
  lastUpdated: string;
}

export interface AbstractionResult {
  newPatterns: TroublePattern[];
  updatedPatterns: TroublePattern[];
  preventionSuggestions: PreventionSuggestion[];
  troublesProcessed: number;
}

export interface PatternMatchResult {
  pattern: TroublePattern;
  trouble: Trouble;
  confidence: number;
  matchedKeywords: string[];
}

export interface AbstractionInput {
  troubles: Trouble[];
  existingPatterns: TroublePattern[];
  cycleId: string;
}
