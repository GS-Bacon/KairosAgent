export interface GeneratedTest {
  targetFile: string;
  testFile: string;
  testCode: string;
  framework: string;
}

export interface TestGenResult {
  tests: GeneratedTest[];
  success: boolean;
  error?: string;
}
