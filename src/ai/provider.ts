export interface CodeContext {
  file: string;
  existingCode?: string;
  relatedFiles?: Array<{ path: string; content: string }>;
  issue?: string;
}

export interface TestContext {
  targetFile: string;
  targetCode: string;
  testFramework?: string;
  existingTests?: string;
}

export interface Analysis {
  issues: Array<{
    type: string;
    severity: "low" | "medium" | "high";
    message: string;
    line?: number;
  }>;
  suggestions: string[];
  quality: {
    score: number;
    details: string;
  };
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

export interface AIProvider {
  name: string;

  generateCode(prompt: string, context: CodeContext): Promise<string>;

  generateTest(code: string, context: TestContext): Promise<string>;

  analyzeCode(code: string): Promise<Analysis>;

  searchAndAnalyze(query: string, codebase: string[]): Promise<SearchResult>;

  chat(prompt: string): Promise<string>;

  isAvailable(): Promise<boolean>;
}
