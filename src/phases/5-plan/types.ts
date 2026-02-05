export interface PlanStep {
  order: number;
  action: "create" | "modify" | "delete" | "refactor";
  file: string;
  details: string;
  estimatedLines?: number;
}

export interface Plan {
  id: string;
  targetType: "issue" | "improvement";
  targetId: string;
  description: string;
  steps: PlanStep[];
  affectedFiles: string[];
  risk: "low" | "medium" | "high";
  requiresTest: boolean;
}
