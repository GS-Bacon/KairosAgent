import { spawn } from "child_process";
import {
  AIProvider,
  CodeContext,
  TestContext,
  Analysis,
  SearchResult,
} from "./provider.js";
import { logger } from "../core/logger.js";

export class ClaudeProvider implements AIProvider {
  name = "claude";

  private async runClaude(prompt: string, options: { print?: boolean } = {}): Promise<string> {
    return new Promise((resolve, reject) => {
      const args = ["--print", prompt];
      const proc = spawn("claude", args, {
        stdio: ["pipe", "pipe", "pipe"],
      });

      let stdout = "";
      let stderr = "";

      proc.stdout.on("data", (data) => {
        stdout += data.toString();
      });

      proc.stderr.on("data", (data) => {
        stderr += data.toString();
      });

      proc.on("close", (code) => {
        if (code !== 0) {
          logger.error("Claude CLI failed", { code, stderr });
          reject(new Error(`Claude CLI exited with code ${code}: ${stderr}`));
        } else {
          resolve(stdout.trim());
        }
      });

      proc.on("error", (err) => {
        reject(err);
      });
    });
  }

  async generateCode(prompt: string, context: CodeContext): Promise<string> {
    const fullPrompt = `You are a code generator. Generate ONLY the code, no explanations.

File: ${context.file}
${context.existingCode ? `Existing code:\n${context.existingCode}` : ""}
${context.issue ? `Issue to fix: ${context.issue}` : ""}

Task: ${prompt}

Output ONLY the complete code for the file, nothing else.`;

    return this.runClaude(fullPrompt);
  }

  async generateTest(code: string, context: TestContext): Promise<string> {
    const fullPrompt = `Generate unit tests for the following code.

Target file: ${context.targetFile}
${context.testFramework ? `Test framework: ${context.testFramework}` : "Use vitest"}

Code to test:
\`\`\`
${code}
\`\`\`

${context.existingTests ? `Existing tests:\n${context.existingTests}` : ""}

Output ONLY the test code, no explanations.`;

    return this.runClaude(fullPrompt);
  }

  async analyzeCode(code: string): Promise<Analysis> {
    const prompt = `Analyze this code for issues and quality. Output JSON only.

Code:
\`\`\`
${code}
\`\`\`

Output format (JSON only):
{
  "issues": [{"type": "string", "severity": "low|medium|high", "message": "string", "line": number}],
  "suggestions": ["string"],
  "quality": {"score": 0-100, "details": "string"}
}`;

    const response = await this.runClaude(prompt);
    try {
      const jsonMatch = response.match(/\{[\s\S]*\}/);
      if (jsonMatch) {
        return JSON.parse(jsonMatch[0]);
      }
      throw new Error("No JSON found in response");
    } catch {
      return {
        issues: [],
        suggestions: [],
        quality: { score: 50, details: "Unable to parse analysis" },
      };
    }
  }

  async searchAndAnalyze(query: string, codebase: string[]): Promise<SearchResult> {
    const codebaseStr = codebase
      .slice(0, 20)
      .map((f) => `- ${f}`)
      .join("\n");

    const prompt = `Search query: ${query}

Available files:
${codebaseStr}

Analyze which files are most relevant and why. Output JSON:
{
  "query": "${query}",
  "findings": [{"file": "path", "content": "summary", "relevance": 0-1}],
  "analysis": "overall analysis"
}`;

    const response = await this.runClaude(prompt);
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
    return this.runClaude(prompt);
  }

  async isAvailable(): Promise<boolean> {
    try {
      const proc = spawn("claude", ["--version"], { stdio: "pipe" });
      return new Promise((resolve) => {
        proc.on("close", (code) => resolve(code === 0));
        proc.on("error", () => resolve(false));
      });
    } catch {
      return false;
    }
  }
}
