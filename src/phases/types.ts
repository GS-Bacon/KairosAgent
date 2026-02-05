export interface Issue {
  id: string;
  type: "error" | "warning" | "critical";
  source: string;
  message: string;
  file?: string;
  line?: number;
  timestamp: Date;
}

export interface Improvement {
  id: string;
  type: "todo" | "fixme" | "optimization" | "refactor" | "security";
  description: string;
  file: string;
  line?: number;
  priority: "low" | "medium" | "high";
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
  }>;
  testResults?: {
    passed: boolean;
    totalTests: number;
    passedTests: number;
    failedTests: number;
    errors: string[];
  };
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
