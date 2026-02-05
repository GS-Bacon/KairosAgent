import { logger } from "../core/logger.js";
import { ClaudeProvider } from "../ai/claude-provider.js";
import { OpenCodeProvider } from "../ai/opencode-provider.js";
import * as fs from "fs";
import * as path from "path";

export interface GuardConfig {
  maxFilesPerChange: number;
  maxLinesPerFile: number;
  protectedPatterns: string[];
  allowedExtensions: string[];
  aiReviewEnabled: boolean;
  aiReviewLogPath: string;
}

export interface AIReviewResult {
  timestamp: string;
  code: string;
  warnings: string[];
  context: string;
  claudeVerdict: { approved: boolean; reason: string } | null;
  openCodeVerdict: { approved: boolean; reason: string } | null;
  finalDecision: "approved" | "rejected";
}

const DEFAULT_CONFIG: GuardConfig = {
  maxFilesPerChange: 5,
  maxLinesPerFile: 500,
  protectedPatterns: [
    "src/safety/",
    "src/core/logger.ts",
    "package.json",
    "tsconfig.json",
    ".env",
  ],
  allowedExtensions: [".ts", ".js", ".json", ".md"],
  aiReviewEnabled: true,
  aiReviewLogPath: "workspace/ai-review-log.json",
};

export class Guard {
  private config: GuardConfig;
  private claudeProvider: ClaudeProvider | null = null;
  private openCodeProvider: OpenCodeProvider | null = null;
  private reviewLog: AIReviewResult[] = [];

  constructor(config: Partial<GuardConfig> = {}) {
    this.config = { ...DEFAULT_CONFIG, ...config };
    this.loadReviewLog();
  }

  private loadReviewLog(): void {
    try {
      const logPath = path.resolve(this.config.aiReviewLogPath);
      if (fs.existsSync(logPath)) {
        const data = fs.readFileSync(logPath, "utf-8");
        this.reviewLog = JSON.parse(data);
      }
    } catch (err) {
      logger.warn("Failed to load AI review log", { error: err });
    }
  }

  private saveReviewLog(): void {
    try {
      const logPath = path.resolve(this.config.aiReviewLogPath);
      const dir = path.dirname(logPath);
      if (!fs.existsSync(dir)) {
        fs.mkdirSync(dir, { recursive: true });
      }
      fs.writeFileSync(logPath, JSON.stringify(this.reviewLog, null, 2));
    } catch (err) {
      logger.warn("Failed to save AI review log", { error: err });
    }
  }

  initializeAIProviders(): void {
    this.claudeProvider = new ClaudeProvider();
    this.openCodeProvider = new OpenCodeProvider();
  }

  isFileProtected(filePath: string): boolean {
    for (const pattern of this.config.protectedPatterns) {
      if (filePath.includes(pattern)) {
        return true;
      }
    }
    return false;
  }

  isExtensionAllowed(filePath: string): boolean {
    return this.config.allowedExtensions.some((ext) => filePath.endsWith(ext));
  }

  validateChange(change: {
    files: string[];
    totalLines?: number;
  }): { allowed: boolean; reason?: string } {
    if (change.files.length > this.config.maxFilesPerChange) {
      return {
        allowed: false,
        reason: `Too many files: ${change.files.length} > ${this.config.maxFilesPerChange}`,
      };
    }

    for (const file of change.files) {
      if (this.isFileProtected(file)) {
        return {
          allowed: false,
          reason: `Protected file: ${file}`,
        };
      }

      if (!this.isExtensionAllowed(file)) {
        return {
          allowed: false,
          reason: `Disallowed extension: ${file}`,
        };
      }
    }

    if (
      change.totalLines !== undefined &&
      change.totalLines > this.config.maxLinesPerFile
    ) {
      return {
        allowed: false,
        reason: `Too many lines: ${change.totalLines} > ${this.config.maxLinesPerFile}`,
      };
    }

    return { allowed: true };
  }

  validateCodeContent(code: string): { safe: boolean; warnings: string[] } {
    const warnings: string[] = [];

    const dangerousPatterns = [
      { pattern: /eval\s*\(/, name: "eval()" },
      { pattern: /exec\s*\(/, name: "exec()" },
      { pattern: /child_process/, name: "child_process" },
      { pattern: /rm\s+-rf/, name: "rm -rf" },
      { pattern: /process\.exit/, name: "process.exit" },
      { pattern: /require\s*\(\s*['"`]\s*\+/, name: "dynamic require" },
    ];

    for (const { pattern, name } of dangerousPatterns) {
      if (pattern.test(code)) {
        warnings.push(`Potentially dangerous: ${name}`);
      }
    }

    return {
      safe: warnings.length === 0,
      warnings,
    };
  }

  async validateCodeWithAI(
    code: string,
    context: string,
    warnings: string[]
  ): Promise<{ approved: boolean; reason: string }> {
    if (!this.config.aiReviewEnabled) {
      return { approved: false, reason: "AI review disabled" };
    }

    const prompt = `あなたはセキュリティレビュアーです。以下のコードが自律AIシステムの自己改善として正当かどうか判断してください。

## 検出された警告
${warnings.join("\n")}

## コンテキスト
${context}

## コード
\`\`\`
${code.slice(0, 2000)}
\`\`\`

## 判断基準
- child_process: CLIツール呼び出しに必要な場合は正当
- eval/exec: 動的コード実行が本当に必要な場合のみ正当
- process.exit: エラーハンドリングの一部なら正当
- rm -rf: ほぼ常に危険

## 回答形式（JSON）
{"approved": true/false, "reason": "判断理由"}

JSONのみを出力してください。`;

    let claudeVerdict: { approved: boolean; reason: string } | null = null;
    let openCodeVerdict: { approved: boolean; reason: string } | null = null;

    // Claude判断
    if (this.claudeProvider) {
      try {
        const claudeResponse = await this.claudeProvider.chat(prompt);
        const match = claudeResponse.match(/\{[\s\S]*\}/);
        if (match) {
          claudeVerdict = JSON.parse(match[0]);
          logger.info("Claude security review", { verdict: claudeVerdict });
        }
      } catch (err) {
        logger.warn("Claude security review failed", { error: err });
      }
    }

    // OpenCode判断
    if (this.openCodeProvider) {
      try {
        const openCodeResponse = await this.openCodeProvider.chat(prompt);
        const match = openCodeResponse.match(/\{[\s\S]*\}/);
        if (match) {
          openCodeVerdict = JSON.parse(match[0]);
          logger.info("OpenCode security review", { verdict: openCodeVerdict });
        }
      } catch (err) {
        logger.warn("OpenCode security review failed", { error: err });
      }
    }

    // 判定ロジック：両方がapproved、またはClaudeのみがapproved
    let finalDecision: "approved" | "rejected" = "rejected";
    let reason = "No AI verdict available";

    if (claudeVerdict && openCodeVerdict) {
      if (claudeVerdict.approved && openCodeVerdict.approved) {
        finalDecision = "approved";
        reason = `Both AIs approved: Claude(${claudeVerdict.reason}), OpenCode(${openCodeVerdict.reason})`;
      } else if (claudeVerdict.approved && !openCodeVerdict.approved) {
        finalDecision = "approved";
        reason = `Claude approved (${claudeVerdict.reason}), OpenCode rejected (${openCodeVerdict.reason}) - trusting Claude`;
      } else {
        finalDecision = "rejected";
        reason = `Rejected: Claude(${claudeVerdict.reason}), OpenCode(${openCodeVerdict.reason})`;
      }
    } else if (claudeVerdict) {
      finalDecision = claudeVerdict.approved ? "approved" : "rejected";
      reason = `Claude only: ${claudeVerdict.reason}`;
    } else if (openCodeVerdict) {
      // OpenCode単独の場合は信頼性評価に基づく（今は保守的に）
      const openCodeTrustScore = this.getOpenCodeTrustScore();
      if (openCodeVerdict.approved && openCodeTrustScore >= 0.8) {
        finalDecision = "approved";
        reason = `OpenCode approved (trust: ${openCodeTrustScore.toFixed(2)}): ${openCodeVerdict.reason}`;
      } else {
        finalDecision = "rejected";
        reason = `OpenCode only (trust: ${openCodeTrustScore.toFixed(2)}): ${openCodeVerdict.reason}`;
      }
    }

    // ログに記録
    const result: AIReviewResult = {
      timestamp: new Date().toISOString(),
      code: code.slice(0, 500),
      warnings,
      context,
      claudeVerdict,
      openCodeVerdict,
      finalDecision,
    };
    this.reviewLog.push(result);
    this.saveReviewLog();

    logger.info("AI security review completed", { finalDecision, reason });
    return { approved: finalDecision === "approved", reason };
  }

  getOpenCodeTrustScore(): number {
    // 過去のレビューからOpenCodeの信頼性を計算
    const recentReviews = this.reviewLog.slice(-20);
    if (recentReviews.length < 5) {
      return 0.0; // データ不足の場合は低信頼
    }

    let agreements = 0;
    let total = 0;

    for (const review of recentReviews) {
      if (review.claudeVerdict && review.openCodeVerdict) {
        total++;
        if (review.claudeVerdict.approved === review.openCodeVerdict.approved) {
          agreements++;
        }
      }
    }

    if (total === 0) return 0.0;
    return agreements / total;
  }

  getReviewStats(): { total: number; openCodeTrust: number; recentReviews: AIReviewResult[] } {
    return {
      total: this.reviewLog.length,
      openCodeTrust: this.getOpenCodeTrustScore(),
      recentReviews: this.reviewLog.slice(-10),
    };
  }

  getConfig(): GuardConfig {
    return { ...this.config };
  }

  updateConfig(updates: Partial<GuardConfig>): void {
    this.config = { ...this.config, ...updates };
    logger.info("Guard config updated", { config: this.config });
  }
}

export const guard = new Guard();
