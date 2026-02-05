import { execSync } from "child_process";
import {
  AIProvider,
  CodeContext,
  TestContext,
  Analysis,
  SearchResult,
} from "./provider.js";
import { logger } from "../core/logger.js";

export class OpenCodeProvider implements AIProvider {
  name = "opencode";

  private runOpenCode(prompt: string): string {
    try {
      // ダブルクォートとバックスラッシュをエスケープ
      const escapedPrompt = prompt
        .replace(/\\/g, "\\\\")
        .replace(/"/g, '\\"')
        .replace(/\$/g, "\\$")
        .replace(/`/g, "\\`");
      const result = execSync(`opencode run "${escapedPrompt}"`, {
        encoding: "utf-8",
        timeout: 120000,
        maxBuffer: 10 * 1024 * 1024,
      });
      return result.trim();
    } catch (err) {
      logger.error("OpenCode execution failed", {
        error: err instanceof Error ? err.message : String(err),
      });
      throw err;
    }
  }

  async generateCode(prompt: string, context: CodeContext): Promise<string> {
    const fullPrompt = `You are a code generator. Generate ONLY the code, no explanations.

File: ${context.file}
${context.existingCode ? `Existing code:\n${context.existingCode}` : ""}
${context.issue ? `Issue to fix: ${context.issue}` : ""}

Task: ${prompt}

Output ONLY the complete code for the file.`;

    return this.runOpenCode(fullPrompt);
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

    return this.runOpenCode(fullPrompt);
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

    const response = this.runOpenCode(prompt);
    try {
      const jsonMatch = response.match(/\{[\s\S]*\}/);
      if (jsonMatch) {
        return JSON.parse(jsonMatch[0]);
      }
      throw new Error("No JSON found");
    } catch {
      return {
        issues: [],
        suggestions: [],
        quality: { score: 50, details: "Parse error" },
      };
    }
  }

  async searchAndAnalyze(query: string, codebase: string[]): Promise<SearchResult> {
    const prompt = `Query: ${query}\nFiles: ${codebase.slice(0, 20).join(", ")}\n\nOutput JSON: {"query":"","findings":[{"file":"","content":"","relevance":0}],"analysis":""}`;

    const response = this.runOpenCode(prompt);
    try {
      const jsonMatch = response.match(/\{[\s\S]*\}/);
      if (jsonMatch) {
        return JSON.parse(jsonMatch[0]);
      }
      throw new Error("No JSON found");
    } catch {
      return { query, findings: [] };
    }
  }

  async chat(prompt: string): Promise<string> {
    return this.runOpenCode(prompt);
  }

  async isAvailable(): Promise<boolean> {
    try {
      execSync("which opencode", { encoding: "utf-8" });
      return true;
    } catch {
      return false;
    }
  }
}
