import { spawn } from "child_process";
import {
  AIProvider,
  CodeContext,
  TestContext,
  Analysis,
  SearchResult,
} from "./provider.js";
import { logger } from "../core/logger.js";
import { parseJSONObject } from "./json-parser.js";

export interface ClaudeProviderOptions {
  model?: string;           // デフォルト: sonnet (Claude CLIデフォルト)
  planModel?: string;       // plan策定用モデル（デフォルト: opus）
  timeout?: number;         // デフォルト: 300000 (5分)
  idleTimeout?: number;     // データなしのタイムアウト: 60000 (1分)
}

export class ClaudeProvider implements AIProvider {
  name = "claude";
  private options: ClaudeProviderOptions;

  constructor(options: ClaudeProviderOptions = {}) {
    this.options = {
      model: options.model,  // デフォルトはClaude CLIのデフォルト（sonnet）
      planModel: options.planModel || "opus",  // plan策定はopus
      timeout: options.timeout || 900000,      // 15分（最大）
      idleTimeout: options.idleTimeout || 300000, // 5分（初回応答待ち含む）
    };
  }

  private async runClaude(prompt: string, options: { timeout?: number; model?: string } = {}): Promise<string> {
    return new Promise((resolve, reject) => {
      const maxTimeout = options.timeout || this.options.timeout!;
      const idleTimeout = this.options.idleTimeout!;
      const model = options.model || this.options.model;

      // Claude CLIコマンドを構築
      const claudeArgs = ["--print", "--no-session-persistence"];
      if (model) {
        claudeArgs.push("--model", model);
      }
      // プロンプトをシングルクォートでエスケープ
      const escapedPrompt = prompt.replace(/'/g, "'\\''");
      const claudeCmd = `claude ${claudeArgs.join(" ")} '${escapedPrompt}'`;

      // script コマンドでpty経由で実行（Claude CLIはTTY必須）
      const proc = spawn("script", ["-q", "-c", claudeCmd, "/dev/null"], {
        stdio: ["pipe", "pipe", "pipe"],
      });

      let stdout = "";
      let stderr = "";
      let timedOut = false;
      let lastActivity = Date.now();

      // startTimeを先に宣言（checkIdleより前）
      const startTime = Date.now();

      // アクティビティベースのタイムアウト
      const checkIdle = setInterval(() => {
        const idleTime = Date.now() - lastActivity;
        const totalTime = Date.now() - startTime;

        if (idleTime > idleTimeout) {
          timedOut = true;
          logger.warn("Claude CLI idle timeout", { idleTime, idleTimeout });
          proc.kill("SIGTERM");
        } else if (totalTime > maxTimeout) {
          timedOut = true;
          logger.warn("Claude CLI max timeout", { totalTime, maxTimeout });
          proc.kill("SIGTERM");
        }
      }, 5000);

      proc.stdout.on("data", (data) => {
        lastActivity = Date.now();
        stdout += data.toString();
      });

      proc.stderr.on("data", (data) => {
        lastActivity = Date.now();
        stderr += data.toString();
      });

      proc.on("close", (code) => {
        clearInterval(checkIdle);
        const duration = Date.now() - startTime;

        if (timedOut) {
          logger.error("Claude CLI timed out", { duration, maxTimeout, idleTimeout });
          reject(new Error(`Claude CLI timed out after ${duration}ms`));
        } else if (code !== 0) {
          logger.error("Claude CLI failed", { code, stderr, duration });
          reject(new Error(`Claude CLI exited with code ${code}: ${stderr}`));
        } else {
          // scriptコマンドの出力からANSIエスケープシーケンスを除去
          const cleanOutput = stdout
            .replace(/\x1b\[[0-9;]*[a-zA-Z]/g, "")  // ANSI escape codes
            .replace(/\x1b\][^\x07]*\x07/g, "")     // OSC sequences
            .replace(/[\x00-\x08\x0b\x0c\x0e-\x1f]/g, "")  // Control chars
            .trim();
          logger.debug("Claude CLI completed", { duration, responseLength: cleanOutput.length });
          resolve(cleanOutput);
        }
      });

      proc.on("error", (err) => {
        clearInterval(checkIdle);
        reject(err);
      });
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

    return this.runClaude(fullPrompt);
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
    const parsed = parseJSONObject<Analysis>(response);
    if (parsed) {
      return parsed;
    }
    return {
      issues: [],
      suggestions: [],
      quality: { score: 50, details: "Unable to parse analysis" },
    };
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
    const parsed = parseJSONObject<SearchResult>(response);
    if (parsed) {
      return parsed;
    }
    return { query, findings: [] };
  }

  async chat(prompt: string): Promise<string> {
    // plan策定などの重要な判断にはopusを使用
    return this.runClaude(prompt, { model: this.options.planModel });
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
