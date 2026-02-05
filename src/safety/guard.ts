import { logger } from "../core/logger.js";
import { ClaudeProvider } from "../ai/claude-provider.js";
import { OpenCodeProvider } from "../ai/opencode-provider.js";
import * as fs from "fs";
import * as path from "path";

export interface GuardConfig {
  maxFilesPerChange: number;
  maxLinesPerFile: number;
  protectedPatterns: string[];  // 後方互換性（全保護パターン）
  strictlyProtectedPatterns: string[];  // 完全保護（変更不可）
  conditionallyProtectedPatterns: string[];  // 条件付き保護（AIレビュー必須）
  allowedExtensions: string[];
  aiReviewEnabled: boolean;
  aiReviewLogPath: string;
}

export interface AIReviewResult {
  timestamp: string;
  code: string;          // 全コード（旧: 500文字まで）
  codeLength: number;    // コードの全長
  warnings: string[];
  context: string;
  dangerousPatterns: string[];  // 検出された危険パターン
  claudeVerdict: { approved: boolean; reason: string } | null;
  openCodeVerdict: { approved: boolean; reason: string } | null;
  finalDecision: "approved" | "rejected";
  decisionReason: string;       // 判定理由の詳細
}

export interface PathValidationResult {
  valid: boolean;
  originalPath: string;
  correctedPath?: string;
  error?: string;
  errorType?: "duplicate-prefix" | "invalid-chars" | "outside-workspace";
}

const DEFAULT_CONFIG: GuardConfig = {
  maxFilesPerChange: 5,
  maxLinesPerFile: 500,
  // 完全保護: 絶対に変更不可
  strictlyProtectedPatterns: [
    "src/safety/",
  ],
  // 条件付き保護: AIレビューで承認されれば変更可
  conditionallyProtectedPatterns: [
    "src/core/logger.ts",
    "src/ai/claude-provider.ts",
    "src/ai/hybrid-provider.ts",
    "src/ai/factory.ts",
    "src/ai/code-sanitizer.ts",
    "src/ai/shell-escape.ts",
    "package.json",
    "tsconfig.json",
    ".env",
  ],
  // 後方互換性のため protectedPatterns も維持（両方の合計）
  protectedPatterns: [
    "src/safety/",
    "src/core/logger.ts",
    "src/ai/claude-provider.ts",
    "src/ai/hybrid-provider.ts",
    "src/ai/factory.ts",
    "src/ai/code-sanitizer.ts",
    "src/ai/shell-escape.ts",
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

  /**
   * 完全保護ファイルかどうか（絶対に変更不可）
   */
  isStrictlyProtected(filePath: string): boolean {
    for (const pattern of this.config.strictlyProtectedPatterns) {
      if (filePath.includes(pattern)) {
        return true;
      }
    }
    return false;
  }

  /**
   * 条件付き保護ファイルかどうか（AIレビュー必須）
   */
  isConditionallyProtected(filePath: string): boolean {
    for (const pattern of this.config.conditionallyProtectedPatterns) {
      if (filePath.includes(pattern)) {
        return true;
      }
    }
    return false;
  }

  /**
   * 保護ファイル変更のAIレビュー
   * 条件付き保護ファイルへの変更が正当かどうかをAIに判断させる
   */
  async reviewProtectedFileChange(
    filePath: string,
    changeDescription: string,
    proposedCode?: string
  ): Promise<{ approved: boolean; reason: string }> {
    if (!this.config.aiReviewEnabled) {
      return { approved: false, reason: "AI review disabled" };
    }

    const prompt = `あなたはセキュリティレビュアーです。以下の保護ファイルへの変更が正当かどうか判断してください。

## 対象ファイル
${filePath}

## なぜこのファイルは保護されているか
- AIプロバイダーやコアインフラなど、システムの重要な部分
- 不適切な変更はシステム全体の安定性やセキュリティに影響する

## 変更の説明
${changeDescription}

${proposedCode ? `## 提案されたコード（一部）
\`\`\`
${proposedCode.slice(0, 1500)}
\`\`\`` : ""}

## 判断基準
1. 変更がシステムの安定性を損なわないか
2. セキュリティ機構を弱体化させないか
3. 変更の目的が正当な改善であるか（バグ修正、パフォーマンス改善など）
4. 変更が必要最小限であるか

## 回答形式（JSON）
{"approved": true/false, "reason": "判断理由"}

JSONのみを出力してください。`;

    let claudeVerdict: { approved: boolean; reason: string } | null = null;

    // Claude判断（保護ファイルの変更はClaudeの承認必須）
    if (this.claudeProvider) {
      try {
        const claudeResponse = await this.claudeProvider.chat(prompt);
        const match = claudeResponse.match(/\{[\s\S]*\}/);
        if (match) {
          claudeVerdict = JSON.parse(match[0]);
          logger.info("Claude protected file review", {
            file: filePath,
            verdict: claudeVerdict,
          });
        }
      } catch (err) {
        logger.warn("Claude protected file review failed", { error: err });
      }
    }

    if (!claudeVerdict) {
      return {
        approved: false,
        reason: "Claude review required but unavailable",
      };
    }

    // ログに記録
    const result: AIReviewResult = {
      timestamp: new Date().toISOString(),
      code: proposedCode || changeDescription,
      codeLength: proposedCode?.length || changeDescription.length,
      warnings: [`Protected file change: ${filePath}`],
      context: `Protected file review: ${changeDescription}`,
      dangerousPatterns: [],
      claudeVerdict,
      openCodeVerdict: null,
      finalDecision: claudeVerdict.approved ? "approved" : "rejected",
      decisionReason: `Protected file review: ${claudeVerdict.reason}`,
    };
    this.reviewLog.push(result);
    this.saveReviewLog();

    return claudeVerdict;
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

    // 検出された危険パターンのリスト
    const detectedPatterns = this.extractDangerousPatterns(code);

    // ログに記録（全コード保存、保持期間延長のため詳細に）
    const result: AIReviewResult = {
      timestamp: new Date().toISOString(),
      code: code,  // 全コード保存
      codeLength: code.length,
      warnings,
      context,
      dangerousPatterns: detectedPatterns,
      claudeVerdict,
      openCodeVerdict,
      finalDecision,
      decisionReason: reason,
    };
    this.reviewLog.push(result);

    // 古いログを削除（30日分を保持）
    this.pruneOldReviewLogs();
    this.saveReviewLog();

    logger.info("AI security review completed", {
      finalDecision,
      reason,
      codeLength: code.length,
      dangerousPatterns: detectedPatterns,
    });
    return { approved: finalDecision === "approved", reason };
  }

  /**
   * コードから危険パターンを抽出
   */
  private extractDangerousPatterns(code: string): string[] {
    const patterns: string[] = [];
    const dangerousPatterns = [
      { pattern: /eval\s*\(/, name: "eval()" },
      { pattern: /exec\s*\(/, name: "exec()" },
      { pattern: /child_process/, name: "child_process" },
      { pattern: /rm\s+-rf/, name: "rm -rf" },
      { pattern: /process\.exit/, name: "process.exit" },
      { pattern: /require\s*\(\s*['"`]\s*\+/, name: "dynamic require" },
      { pattern: /spawn\s*\(/, name: "spawn()" },
      { pattern: /execSync\s*\(/, name: "execSync()" },
      { pattern: /writeFileSync\s*\([^)]*\/etc\//, name: "write to /etc" },
      { pattern: /fetch\s*\([^)]*file:\/\//, name: "file:// fetch" },
    ];

    for (const { pattern, name } of dangerousPatterns) {
      if (pattern.test(code)) {
        patterns.push(name);
      }
    }

    return patterns;
  }

  /**
   * 30日より古いレビューログを削除
   */
  private pruneOldReviewLogs(): void {
    const thirtyDaysAgo = new Date();
    thirtyDaysAgo.setDate(thirtyDaysAgo.getDate() - 30);
    const threshold = thirtyDaysAgo.toISOString();

    const beforeCount = this.reviewLog.length;
    this.reviewLog = this.reviewLog.filter((r) => r.timestamp >= threshold);
    const prunedCount = beforeCount - this.reviewLog.length;

    if (prunedCount > 0) {
      logger.debug("Pruned old review logs", { prunedCount, remaining: this.reviewLog.length });
    }
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

  /**
   * パスを正規化する
   * - 重複プレフィックス（src/src/）を除去
   * - 連続スラッシュを単一スラッシュに
   * - 先頭の ./ を除去
   */
  normalizePath(filePath: string): string {
    let normalized = filePath;

    // 先頭の ./ を除去
    normalized = normalized.replace(/^\.\//, "");

    // 連続スラッシュを単一スラッシュに
    normalized = normalized.replace(/\/+/g, "/");

    // 重複プレフィックスを除去（src/src/ → src/）
    const duplicatePrefixPattern = /^(src|workspace|dist|apps)(\/\1)+\//;
    while (duplicatePrefixPattern.test(normalized)) {
      normalized = normalized.replace(duplicatePrefixPattern, "$1/");
    }

    // より単純なケース: src/src/ → src/
    while (normalized.includes("src/src/")) {
      normalized = normalized.replace(/src\/src\//g, "src/");
    }
    while (normalized.includes("workspace/workspace/")) {
      normalized = normalized.replace(/workspace\/workspace\//g, "workspace/");
    }

    return normalized;
  }

  /**
   * パスを検証し、問題があれば修正案を返す
   */
  validatePath(filePath: string): PathValidationResult {
    const originalPath = filePath;

    // ディレクトリトラバーサルの検出（../ を含む）
    if (filePath.includes("../") || filePath.includes("..\\")) {
      return {
        valid: false,
        originalPath,
        error: "Directory traversal detected",
        errorType: "outside-workspace",
      };
    }

    // 危険な文字の検出
    const invalidCharsPattern = /[<>:"|?*\x00-\x1f]/;
    if (invalidCharsPattern.test(filePath)) {
      return {
        valid: false,
        originalPath,
        error: "Invalid characters in path",
        errorType: "invalid-chars",
      };
    }

    // 正規化を試みる
    const normalized = this.normalizePath(filePath);

    // パスが変更された場合、重複プレフィックスがあった
    if (normalized !== filePath.replace(/^\.\//, "")) {
      logger.warn("Path normalization applied", {
        original: filePath,
        normalized,
      });
      return {
        valid: true,
        originalPath,
        correctedPath: normalized,
        errorType: "duplicate-prefix",
      };
    }

    return {
      valid: true,
      originalPath,
    };
  }
}

export const guard = new Guard();
