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
}
