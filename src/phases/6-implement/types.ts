export interface ImplementationChange {
  file: string;
  changeType: "create" | "modify" | "delete";
  originalContent?: string;
  newContent?: string;
  success: boolean;
  error?: string;
  summary?: string;       // 変更内容の要約
  relatedIssue?: string;  // 関連するIssue/Improvement ID
}

export interface ImplementationResult {
  planId: string;
  changes: ImplementationChange[];
  snapshotId: string;
  success: boolean;
  skipped?: boolean;  // 保護ファイルのAIレビュー却下でスキップされた場合
  skipReason?: string;  // スキップの理由
  appealHistory?: {
    trialsCompleted: number;
    approved: boolean;
    finalReason: string;
  };
}
