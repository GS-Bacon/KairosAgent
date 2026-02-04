export interface Problem {
  id: string;
  timestamp: Date;
  type: 'error' | 'failure' | 'inefficiency' | 'risk';
  description: string;
  context: Record<string, unknown>;
  stackTrace?: string;
  relatedTaskId?: string;
  severity: number;
}

export interface RootCause {
  problemId: string;
  category: RootCauseCategory;
  description: string;
  evidence: string[];
  confidence: number;
  depth: number;
}

export enum RootCauseCategory {
  // プロセス関連
  PROCESS_MISSING = 'process_missing',
  PROCESS_FLAWED = 'process_flawed',
  PROCESS_NOT_FOLLOWED = 'process_not_followed',

  // 知識関連
  KNOWLEDGE_GAP = 'knowledge_gap',
  OUTDATED_INFO = 'outdated_info',
  ASSUMPTION_WRONG = 'assumption_wrong',

  // 技術関連
  CODE_BUG = 'code_bug',
  DESIGN_FLAW = 'design_flaw',
  INTEGRATION_ISSUE = 'integration_issue',

  // 外部要因
  EXTERNAL_CHANGE = 'external_change',
  DEPENDENCY_FAILURE = 'dependency_failure',
  RESOURCE_CONSTRAINT = 'resource_constraint',

  // 判断関連
  RISK_UNDERESTIMATED = 'risk_underestimated',
  WRONG_DECISION = 'wrong_decision',
}

export interface ProcessImprovement {
  id: string;
  rootCauseId: string;
  type: 'add' | 'modify' | 'remove';
  target: 'process' | 'code' | 'config' | 'strategy' | 'knowledge';
  description: string;
  implementation: string;
  expectedOutcome: string;
  verificationMethod: string;
  status: 'proposed' | 'approved' | 'implemented' | 'verified' | 'failed' | 'rejected';
  appliedAt?: Date;
  verifiedAt?: Date;
  effectivenessScore?: number;
}

export interface RecurringPattern {
  category: string;
  occurrences: number;
  firstOccurrence: Date;
  lastOccurrence: Date;
  frequency: number;
  severity: number;
  suggestedAction?: string;
}

export interface LearningReport {
  date: Date;
  problemCount: number;
  recurringPatterns: RecurringPattern[];
  pendingImprovements: number;
  verifiedToday: number;
  recommendations: string[];
}

export interface WhyAnalysis {
  answer: string;
  category: RootCauseCategory;
  evidence: string[];
  confidence: number;
  isRootCause: boolean;
}
