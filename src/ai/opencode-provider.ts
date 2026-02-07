import { spawn, execSync } from "child_process";
import {
  AIProvider,
  CodeContext,
  TestContext,
  Analysis,
  SearchResult,
} from "./provider.js";
import { logger } from "../core/logger.js";
import { parseJSONObject } from "./json-parser.js";
import { OPENCODE } from "../config/constants.js";

export class OpenCodeProvider implements AIProvider {
  name = "opencode";
  private maxTimeout: number;

  constructor(options: { maxTimeout?: number } = {}) {
    this.maxTimeout = options.maxTimeout || OPENCODE.MAX_TIMEOUT_MS;
  }

  /**
   * イベントベースの終了検出でOpenCodeを実行
   * stdin経由でプロンプトを渡す（長いプロンプトでも安全）
   */
  private runOpenCode(prompt: string): Promise<string> {
    return new Promise((resolve, reject) => {
      // stdin経由でプロンプトを渡す（"-" は標準入力から読み込む）
      const proc = spawn("opencode", ["run", "-"], {
        stdio: ["pipe", "pipe", "pipe"],
      });

      let stdout = "";
      let stderr = "";
      const startTime = Date.now();

      // データ収集
      proc.stdout.on("data", (data) => {
        stdout += data.toString();
      });

      proc.stderr.on("data", (data) => {
        stderr += data.toString();
      });

      // 保険としての最大タイムアウト（5分）
      let timedOut = false;
      const timeoutTimer = setTimeout(() => {
        timedOut = true;
        logger.warn("OpenCode max timeout reached", { maxTimeout: this.maxTimeout });
        proc.kill("SIGTERM");
        // SIGTERMで終了しない場合の保険としてSIGKILL
        setTimeout(() => {
          if (!proc.killed) {
            proc.kill("SIGKILL");
          }
        }, 5000);
      }, this.maxTimeout);

      // 終了検出（closeイベント：即座に検出）
      proc.on("close", (code) => {
        clearTimeout(timeoutTimer);
        const duration = Date.now() - startTime;

        if (timedOut) {
          reject(new Error(`OpenCode timed out after ${this.maxTimeout}ms`));
        } else if (code !== 0) {
          logger.error("OpenCode execution failed", { code, stderr, duration });
          reject(new Error(`OpenCode exited with code ${code}: ${stderr.slice(0, 200)}`));
        } else {
          logger.debug("OpenCode completed", { duration, responseLength: stdout.length });
          resolve(stdout.trim());
        }
      });

      proc.on("error", (err) => {
        clearTimeout(timeoutTimer);
        logger.error("OpenCode spawn error", { error: err.message });
        reject(err);
      });

      // プロンプトをstdinに書き込んで閉じる
      proc.stdin.write(prompt);
      proc.stdin.end();
    });
  }

  async generateCode(prompt: string, context: CodeContext): Promise<string> {
    const fullPrompt = `You are a code generator. Generate ONLY valid TypeScript code, no explanations.
IMPORTANT: Ensure ALL brackets { } [ ] ( ) are properly balanced and closed.

File: ${context.file}
${context.existingCode ? `Existing code:\n${context.existingCode}` : ""}
${context.issue ? `Issue to fix: ${context.issue}` : ""}

Task: ${prompt}

Output ONLY the complete code for the file. Verify bracket balance before responding.`;

    return this.runOpenCode(fullPrompt);
  }

  async generateTest(code: string, context: TestContext): Promise<string> {
    const fullPrompt = `Generate unit tests. Output ONLY valid TypeScript test code, no explanations.
IMPORTANT: Ensure ALL brackets { } [ ] ( ) are properly balanced and closed.

Target file: ${context.targetFile}
${context.testFramework ? `Test framework: ${context.testFramework}` : "Use vitest"}

Code to test:
\`\`\`
${code}
\`\`\`

${context.existingTests ? `Existing tests:\n${context.existingTests}` : ""}
${context.errorFeedback ? context.errorFeedback : ""}

Output ONLY the test code. Verify bracket balance before responding.`;

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

    const response = await this.runOpenCode(prompt);
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

    const response = await this.runOpenCode(prompt);
    const parsed = parseJSONObject<SearchResult>(response);
    if (parsed) {
      return parsed;
    }
    return { query, findings: [] };
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
