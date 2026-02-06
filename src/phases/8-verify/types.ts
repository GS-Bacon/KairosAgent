export interface TestResult {
  passed: boolean;
  totalTests: number;
  passedTests: number;
  failedTests: number;
  errors: string[];
  duration: number;
}

export interface PushResult {
  success: boolean;
  error?: string;
  remote?: string;
  branch?: string;
}

export interface VerificationResult {
  buildPassed: boolean;
  testsPassed: boolean;
  testResult?: TestResult;
  buildErrors: string[];
  committed: boolean;
  commitHash?: string;
  pushed: boolean;
  pushResult?: PushResult;
  rolledBack: boolean;
  rollbackReason?: string;
  autoFixAttempted?: boolean;
  autoFixResult?: FixResult;
  gitignoreUpdated?: string[];
}

export interface FixResult {
  success: boolean;
  fixedErrors: string[];
  remainingErrors: string[];
  changesApplied: string[];
}

export interface AnalyzedError {
  type: "duplicate-path" | "module-not-found" | "syntax-error" | "type-error" | "unknown";
  fixable: boolean;
  fixStrategy?: "mechanical" | "ai-repair";
  details: {
    file?: string;
    line?: string;
    column?: string;
    errorCode?: string;
    [key: string]: string | undefined;
  };
  originalError: string;
}
