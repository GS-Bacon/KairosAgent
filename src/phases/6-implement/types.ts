export interface ImplementationChange {
  file: string;
  changeType: "create" | "modify" | "delete";
  originalContent?: string;
  newContent?: string;
  success: boolean;
  error?: string;
}

export interface ImplementationResult {
  planId: string;
  changes: ImplementationChange[];
  snapshotId: string;
  success: boolean;
  skipped?: boolean;  // 保護ファイルのAIレビュー却下でスキップされた場合
  skipReason?: string;  // スキップの理由
}
