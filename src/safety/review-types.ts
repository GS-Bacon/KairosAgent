/**
 * 参審制AIレビュー + 再提出機能の型定義
 */

/** 各審判の判定結果 */
export interface JudgeVerdict {
  judgeName: string;
  approved: boolean;
  reason: string;
  confidence: number; // 0.0 - 1.0
}

/** 拒否理由の分類 */
export type RejectionCategory =
  | "missing-diff"
  | "missing-context"
  | "security-concern"
  | "quality-concern"
  | "scope-violation"
  | "unknown";

/** 改善可能かどうかの解析結果 */
export interface RejectionAnalysis {
  category: RejectionCategory;
  isRemediable: boolean;
  requiredSupplements: string[];  // 必要な補完情報の種類
  originalReason: string;
}

/** 再提出リクエスト */
export interface AppealRequest {
  filePath: string;
  changeDescription: string;
  proposedCode?: string;
  previousRejection: RejectionAnalysis;
  supplements: Record<string, string>;  // 補完情報（diff, context等）
  attemptNumber: number;
}

/** 再提出結果 */
export interface AppealResult {
  approved: boolean;
  verdicts: JudgeVerdict[];
  votingSummary: VotingSummary;
  attemptNumber: number;
  finalReason: string;
  canAppealAgain: boolean;
}

/** 加重投票の集計 */
export interface VotingSummary {
  weightedApproval: number;    // 加重得票率 (0.0 - 1.0)
  totalJudges: number;
  approvedCount: number;
  rejectedCount: number;
  decidingFactor: string;      // 決定要因の説明
}

/** 三審制設定 */
export interface MultiJudgeConfig {
  enabled: boolean;
  maxTrials: number;             // 三審制（第一審+控訴審+上告審）
  votingThreshold: number;       // 承認に必要な加重得票率
  judgeWeights: {
    claude: number;              // 裁判官（60%）
    opencode: number;            // 陪席（40%）
  };
  requiredJudges: number;        // 最低必要な審判数
  fallbackBehavior: "single-judge" | "reject";
}

/** マルチジャッジレビュー結果 */
export interface MultiJudgeReviewResult {
  approved: boolean;
  verdicts: JudgeVerdict[];
  votingSummary: VotingSummary;
  reason: string;
  canAppeal: boolean;
  rejectionAnalysis?: RejectionAnalysis;
}

/** 三審制の審理レベル */
export type TrialLevel = "first" | "appeal" | "final";

/** 三審制レビュー全体の結果 */
export interface TrialSystemResult {
  approved: boolean;
  trialsCompleted: number;
  trialHistory: MultiJudgeReviewResult[];
  finalReason: string;
}

export const DEFAULT_MULTI_JUDGE_CONFIG: MultiJudgeConfig = {
  enabled: true,
  maxTrials: 3,               // 三審制（第一審+控訴審+上告審）
  votingThreshold: 0.6,
  judgeWeights: {
    claude: 0.6,              // 裁判官
    opencode: 0.4,            // 陪席
  },
  requiredJudges: 2,          // Claude不在時のOpenCode単独承認を禁止
  fallbackBehavior: "reject", // 審判不足時は拒否
};
