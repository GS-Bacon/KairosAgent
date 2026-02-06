import {
  AIProvider,
  CodeContext,
  TestContext,
  Analysis,
  SearchResult,
} from "./provider.js";
import { logger } from "../core/logger.js";
import { parseJSONObject } from "./json-parser.js";

interface GLMConfig {
  apiKey: string;
  baseUrl?: string;
  model?: string;
}

export class GLMProvider implements AIProvider {
  name = "glm";
  private config: GLMConfig;
  private baseUrl: string;
  private model: string;

  constructor(config: GLMConfig) {
    this.config = config;
    this.baseUrl = config.baseUrl || "https://open.bigmodel.cn/api/paas/v4";
    this.model = config.model || "glm-4";
  }

  private async callAPI(messages: Array<{ role: string; content: string }>): Promise<string> {
    const response = await fetch(`${this.baseUrl}/chat/completions`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${this.config.apiKey}`,
      },
      body: JSON.stringify({
        model: this.model,
        messages,
      }),
    });

    if (!response.ok) {
      const error = await response.text();
      logger.error("GLM API error", { status: response.status, error });
      throw new Error(`GLM API error: ${response.status}`);
    }

    const data = await response.json() as { choices: Array<{ message: { content: string } }> };
    return data.choices[0]?.message?.content || "";
  }

  async generateCode(prompt: string, context: CodeContext): Promise<string> {
    const fullPrompt = `You are a TypeScript code generator.

CRITICAL SYNTAX RULES - YOU MUST FOLLOW:
1. All brackets MUST be balanced: (), [], {}
2. All statements MUST be complete - no partial code
3. All strings MUST be properly closed
4. Use proper semicolons and commas
5. All import/export statements MUST be complete
6. Wrap your code in \`\`\`typescript ... \`\`\` block
7. Output ONLY the code - no explanations before or after

File: ${context.file}
${context.existingCode ? `\nExisting code:\n\`\`\`typescript\n${context.existingCode}\n\`\`\`` : ""}
${context.issue ? `\nIssue to fix: ${context.issue}` : ""}

Task: ${prompt}

Generate the COMPLETE, SYNTACTICALLY VALID TypeScript code for this file:`;

    return this.callAPI([{ role: "user", content: fullPrompt }]);
  }

  async generateTest(code: string, context: TestContext): Promise<string> {
    const fullPrompt = `Generate unit tests for the following code.

Target file: ${context.targetFile}
${context.testFramework ? `Test framework: ${context.testFramework}` : "Use vitest"}

Code:
\`\`\`
${code}
\`\`\`

Output ONLY the test code.`;

    return this.callAPI([{ role: "user", content: fullPrompt }]);
  }

  async analyzeCode(code: string): Promise<Analysis> {
    const prompt = `Analyze this code for issues. Output JSON only:
{
  "issues": [{"type": "string", "severity": "low|medium|high", "message": "string"}],
  "suggestions": ["string"],
  "quality": {"score": 0-100, "details": "string"}
}

Code:
\`\`\`
${code}
\`\`\``;

    const response = await this.callAPI([{ role: "user", content: prompt }]);
    const parsed = parseJSONObject<Analysis>(response);
    if (parsed) {
      return parsed;
    }
    return {
      issues: [],
      suggestions: [],
      quality: { score: 50, details: "Parse error" },
    };
  }

  async searchAndAnalyze(query: string, codebase: string[]): Promise<SearchResult> {
    const prompt = `Query: ${query}\nFiles: ${codebase.slice(0, 20).join(", ")}\n\nOutput JSON: {"query":"","findings":[{"file":"","content":"","relevance":0}],"analysis":""}`;

    const response = await this.callAPI([{ role: "user", content: prompt }]);
    const parsed = parseJSONObject<SearchResult>(response);
    if (parsed) {
      return parsed;
    }
    return { query, findings: [] };
  }

  async chat(prompt: string): Promise<string> {
    return this.callAPI([{ role: "user", content: prompt }]);
  }

  async isAvailable(): Promise<boolean> {
    try {
      await this.callAPI([{ role: "user", content: "ping" }]);
      return true;
    } catch {
      return false;
    }
  }
}
