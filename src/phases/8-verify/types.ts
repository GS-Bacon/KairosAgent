export interface TestResult {
  passed: boolean;
  totalTests: number;
  passedTests: number;
  failedTests: number;
  errors: string[];
  duration: number;
}

export interface VerificationResult {
  buildPassed: boolean;
  testsPassed: boolean;
  testResult?: TestResult;
  buildErrors: string[];
  committed: boolean;
  commitHash?: string;
  rolledBack: boolean;
  rollbackReason?: string;
}
