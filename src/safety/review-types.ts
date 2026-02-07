/**
 * AIレビュー型定義
 */

/** 三審制の審理レベル */
export type TrialLevel = "first" | "appeal" | "final";

/** レビュー全体の結果 */
export interface TrialSystemResult {
  approved: boolean;
  trialsCompleted: number;
  trialHistory: unknown[];
  finalReason: string;
}
