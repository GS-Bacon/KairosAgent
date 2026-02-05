```typescript
/**
 * ハイブリッドAIプロバイダー
 *
 * Claude + OpenCode/GLMを組み合わせ、フェーズに応じて最適なプロバイダーを選択
 * レートリミット時はGLMにフォールバックし、復活時にClaudeがレビュー
 */

import {
  AIProvider,
  CodeContext,
  TestContext,
  Analysis,
  SearchResult,
} from "./provider.js";
import { ClaudeProvider } from "./claude-provider.js";
import { OpenCodeProvider } from "./opencode-provider.js";
import { GLMProvider } from "./glm-provider.js";
import { logger } from "../core/logger.js";
import { getConfig } from "../index.js";
import { ChangeTracker, changeTracker } from "./change-tracker.js";
import { ClaudeReviewer, claudeReviewer } from "./claude-reviewer.js";
import { getRateLimiter } from "./rate-limiter.js";
import { tokenTracker } from "./token-tracker.js";

export type PhaseName =
  | "health-check"
  | "error-detect"
  | "improve-find"
  | "search"
  | "plan"
  | "implement"
  | "test-gen"
  | "verify";

const PHASE_PROVIDER_MAP: Record<PhaseName, "claude" | "opencode"> = {
  "health-check": "opencode",
  "error-detect": "opencode",
  "improve-find": "opencode",
  "search": "opencode",
  "plan": "claude",
  "implement": "claude",
  "test-gen": "opencode",
  "verify": "opencode",
};

interface RateLimitState {
  isLimited: boolean;
  limitedAt: Date | null;
  backoffUntil: Date | null;
  consecutiveLimits: number;
}

interface TimeoutState {
  isTimedOut: boolean;
  timedOutAt: Date | null;
  backoffUntil: Date | null;
  consecutiveTimeouts: number;
}

export class HybridProvider implements AIProvider {
  name = "hybrid";
  private claudeProvider: ClaudeProvider;
  private openCodeProvider: OpenCodeProvider;
  private glmProvider: GLMProvider | null = null;
  private currentPhase: PhaseName = "health-check";
  private openCodeAvailable: boolean = false;
  private glmAvailable: boolean = false;

  private changeTracker: ChangeTracker;
  private reviewer: ClaudeReviewer;
  private rateLimitState: RateLimitState = {
    isLimited: false,
    limitedAt: null,
    backoffUntil: null,
    consecutiveLimits: 0,
  };

  private timeoutState: TimeoutState = {
    isTimedOut: false,
    timedOutAt: null,
    backoffUntil: null,
    consecutiveTimeouts: 0,
  };

  // バックオフ設定（指数関数的）
  private readonly BASE_BACKOFF_MS = 60000; // 1分
  private readonly MAX_BACKOFF_MS = 600000; // 10分

  // タイムアウト用バックオフ設定
  private readonly TIMEOUT_BASE_BACKOFF_MS = 30000; // 30秒
  private readonly TIMEOUT_MAX_BACKOFF_MS = 300000; // 5分

  constructor() {
    this.claudeProvider = new ClaudeProvider();
    this.openCodeProvider = new OpenCodeProvider();
    this.changeTracker = changeTracker;
    this.reviewer = claudeReviewer;

    // GLMプロバイダーの初期化
    this.initializeGLM();
  }

  /**
   * GLMプロバイダーを初期化
   */
  private initializeGLM(): void {
    const apiKey = process.env.GLM_API_KEY;
    if (apiKey) {
      this.glmProvider = new GLMProvider({
        apiKey,
        model: "glm-4",
      });
      logger.info("GLM provider initialized for rate limit fallback");
    } else {
      logger.debug("GLM_API_KEY not set, fallback disabled");
    }
  }

  setCurrentPhase(phase: PhaseName): void {
    this.currentPhase = phase;
    logger.debug("Hybrid provider phase set", {
      phase,
      provider: PHASE_PROVIDER_MAP[phase],
    });
  }

  getCurrentPhase(): PhaseName {
    return this.currentPhase;
  }

  /**
   * レートリミットエラーかどうかを判定
   */
  private isRateLimitError(err: Error): boolean {
    const message = err.message.toLowerCase();
    return (
      message.includes("rate limit") ||
      message.includes("429") ||
      message.includes("overloaded") ||
      message.includes("too many requests") ||
      message.includes("capacity")
    );
  }

  /**
   * タイムアウトエラーかどうかを判定
   */
  private isTimeoutError(err: Error): boolean {
    const message = err.message.toLowerCase();
    return (
      message.includes("timeout") ||
      message.includes("timed out") ||
      message.includes("etimedout") ||
      message.includes("esockettimedout") ||
      message.includes("econnaborted")
    );
  }

  /**
   * レートリミット状態を更新
   */
  private recordRateLimit(): void {
    const now = new Date();
    this.rateLimitState.isLimited = true;
    this.rateLimitState.limitedAt = now;
    this.rateLimitState.consecutiveLimits++;

    // 指数バックオフ計算
    const backoffMs = Math.min(
      this.BASE_BACKOFF_MS * Math.pow(2, this.rateLimitState.consecutiveLimits - 1),
      this.MAX_BACKOFF_MS
    );

    this.rateLimitState.backoffUntil = new Date(now.getTime() + backoffMs);

    logger.warn("Claude rate limited", {
      consecutiveLimits: this.rateLimitState.consecutiveLimits,
      backoffMs,
      backoffUntil: this.rateLimitState.backoffUntil.toISOString(),
    });

    // RateLimiterのバックオフも更新
    const limiter = getRateLimiter("claude");
    limiter.backoffOnRateLimit(2);
  }

  /**
   * タイムアウト状態を更新
   */
  private recordTimeout(): void {
    const now = new Date();
    this.timeoutState.isTimedOut = true;
    this.timeoutState.timedOutAt = now;
    this.timeoutState.consecutiveTimeouts++;

    // 指数バックオフ計算（タイムアウト用）
    const backoffMs = Math.min(
      this.TIMEOUT_BASE_BACKOFF_MS * Math.pow(2, this.timeoutState.consecutiveTimeouts - 1),
      this.TIMEOUT_MAX_BACKOFF_MS
    );

    this.timeoutState.backoffUntil = new Date(now.getTime() + backoffMs);

    logger.warn("Claude timed out", {
      consecutiveTimeouts: this.timeoutState.consecutiveTimeouts,
      backoffMs,
      backoffUntil: this.timeoutState.backoffUntil.toISOString(),
    });
  }

  /**
   * レートリミットが解除されたかチェック
   */
  private isRateLimitExpired(): boolean {
    if (!this.rateLimitState.backoffUntil) {
      return true;
    }
    return new Date() > this.rateLimitState.backoffUntil;
  }

  /**
   * タイムアウトバックオフが解除されたかチェック
   */
  private isTimeoutExpired(): boolean {
    if (!this.timeoutState.backoffUntil) {
      return true;
    }
    return new Date() > this.timeoutState.backoffUntil;
  }

  /**
   * Claudeが利用可能かチェック（レートリミットとタイムアウト考慮）
   */
  private async isClaudeAvailable(): Promise<boolean> {
    // レートリミットチェック
    if (this.rateLimitState.isLimited && !this.isRateLimitExpired()) {
      logger.debug("Claude still in rate limit backoff", {
        backoffUntil: this.rateLimitState.backoffUntil?.toISOString(),
      });
      return false;
    }

    // タイムアウトチェック
    if (this.timeoutState.isTimedOut && !this.isTimeoutExpired()) {
      logger.debug("Claude still in timeout backoff", {
        backoffUntil: this.timeoutState.backoffUntil?.toISOString(),
      });
      return false;
    }

    try {
      const available = await this.claudeProvider.isAvailable();
      if (available) {
        // レートリミット解除
        if (this.rateLimitState.isLimited) {
          logger.info("Claude rate limit cleared");
          this.rateLimitState.isLimited = false;
          this.rateLimitState.consecutiveLimits = 0;
        }
        // タイムアウト解除
        if (this.timeoutState.isTimedOut) {
          logger.info("Claude timeout cleared");
          this.timeoutState.isTimedOut = false;
          this.timeoutState.consecutiveTimeouts = 0;
        }
      }
      return available;
    } catch {
      return false;
    }
  }

  /**
   * GLMにフォールバックして変更を追跡
   */
  private async executeWithGLMFallback<T>(
    operation: (provider: AIProvider) => Promise<T>,
    context: { files?: string[]; description: string; inputText?: string }
  ): Promise<{ result: T; usedProvider: string }> {
    const config = getConfig();
    const shouldTrack = config.rateLimitFallback.trackChanges;

    // まずClaudeを試行
    if (await this.isClaudeAvailable()) {
      try {
        // Claude復活時、未レビューの変更をレビュー
        await this.reviewPendingGLMChanges();

        const result = await operation(this.claudeProvider);

        // トークン使用量を記録（文字数ベースの推定）
        if (context.inputText) {
          const outputText = typeof result === "string" ? result : JSON.stringify(result);
          tokenTracker.recordFromText(this.currentPhase, "claude", context.inputText, outputText);
        }

        return { result, usedProvider: "claude" };
      } catch (err) {
        if (err instanceof Error) {
          if (this.isRateLimitError(err)) {
            this.recordRateLimit();
            // 以下でフォールバックを試みる
          } else if (this.isTimeoutError(err)) {
            this.recordTimeout();
            // 以下でフォールバックを試みる
          } else {
            throw err;
          }
        } else {
          throw err;
        }
      }
    }

    // OpenCodeにフォールバック（タイムアウト時優先）
    if (this.timeoutState.isTimedOut && this.openCodeAvailable) {
      logger.info("Falling back to OpenCode due to timeout", { phase: this.currentPhase });

      const result = await operation(this.openCodeProvider);

      // トークン使用量を記録（文字数ベースの推定）
      if (context.inputText) {
        const outputText = typeof result === "string" ? result : JSON.stringify(result);
        tokenTracker.recordFromText(this.currentPhase, "opencode", context.inputText, outputText);
      }

      // 変更を追跡
      if (shouldTrack) {
        this.changeTracker.recordChange({
          timestamp: new Date().toISOString(),
          phase: this.currentPhase,
          provider: "opencode",
          files: context.files || [],
          description: context.description.substring(0, 500),
        });
      }

      return { result, usedProvider: "opencode" };
    }

    // GLMにフォールバック
    if (!this.glmProvider || !this.glmAvailable) {
      // OpenCodeも試行
      if (this.openCodeAvailable) {
        logger.info("Falling back to OpenCode (GLM not available)", { phase: this.currentPhase });

        const result = await operation(this.openCodeProvider);

        if (context.inputText) {
          const outputText = typeof result === "string" ? result : JSON.stringify(result);
          tokenTracker.recordFromText(this.currentPhase, "opencode", context.inputText, outputText);
        }

        if (shouldTrack) {
          this.changeTracker.recordChange({
            timestamp: new Date().toISOString(),
            phase: this.currentPhase,
            provider: "opencode",
            files: context.files || [],
            description: context.description.substring(0, 500),
          });
        }

        return { result, usedProvider: "opencode" };
      }

      throw new Error("Claude unavailable (rate limited or timed out) and no fallback provider available");
    }

    logger.info("Falling back to GLM", { phase: this.currentPhase });

    const result = await operation(this.glmProvider);

    // トークン使用量を記録（文字数ベースの推定）
    if (context.inputText) {
      const outputText = typeof result === "string" ? result : JSON.stringify(result);
      tokenTracker.recordFromText(this.currentPhase, "glm", context.inputText, outputText);
    }

    // 変更を追跡
    if (shouldTrack) {
      this.changeTracker.recordChange({
        timestamp: new Date().toISOString(),
        phase: this.currentPhase,
        provider: "glm",
        files: context.files || [],
        description: context.description.substring(0, 500),
      });
    }

    return { result, usedProvider: "glm" };
  }

  /**
   * Claude復活時にGLMの変更をレビュー
   */
  private async reviewPendingGLMChanges(): Promise<void> {
    const config = getConfig();

    if (!config.rateLimitFallback.autoReview) {
      return;
    }

    // レビュー対象フェーズかチェック
    if (!config.rateLimitFallback.reviewOnPhases.includes(this.currentPhase)) {
      return;
    }

    const unreviewedCount = this.changeTracker.getUnreviewedChanges().length;

    if (unreviewedCount === 0) {
      return;
    }

    logger.info("Claude available, reviewing GLM changes", {
      count: unreviewedCount,
      phase: this.currentPhase,
    });

    try {
      const report = await this.reviewer.reviewPendingChanges();

      if (report.issues.length > 0) {
        // 問題があれば改善キューに追加
        await this.reviewer.queueIssuesForFix(report);
        logger.warn("GLM changes had issues", {
          rejected: report.rejected,
          issueCount: report.issues.reduce((sum, i) => sum + i.issues.length, 0),
        });
      }
    } catch (err) {
      logger.error("Failed to review GLM changes", {
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }

  private getProviderForPhase(): AIProvider {
    const providerType = PHASE_PROVIDER_MAP[this.currentPhase];

    if (providerType === "opencode" && this.openCodeAvailable) {
      logger.debug("Using OpenCode provider", { phase: this.currentPhase });
      return this.openCodeProvider;
    }

    logger.debug("Using Claude provider", {
      phase: this.currentPhase,
      reason: providerType === "opencode" ? "opencode unavailable" : "phase requires claude",
    });
    return this.claudeProvider;
  }

  async generateCode(prompt: string, context: CodeContext): Promise<string> {
    const config = getConfig();
    const inputText = `${prompt}\n${context.existingCode || ""}`;

    // claudeフェーズでレートリミットフォールバックが有効な場合
    if (
      config.rateLimitFallback.enabled &&
      PHASE_PROVIDER_MAP[this.currentPhase] === "claude"
    ) {
      const { result } = await this.executeWithGLMFallback(
        (provider) => provider.generateCode(prompt, context),
        {
          files: context.file ? [context.file] : [],
          description: `generateCode: ${prompt.substring(0, 200)}`,
          inputText,
        }
      );
      return result;
    }

    const provider = this.getProviderForPhase();

    try {
      const result = await provider.generateCode(prompt, context);

      // トークン使用量を記録
      tokenTracker.recordFromText(this.currentPhase, provider.name, inputText, result);

      return result;
    } catch (err) {
      // タイムアウト時のフォールバック処理
      if (err instanceof Error && this.isTimeoutError(err)) {
        this.recordTimeout();

        // OpenCodeにフォールバック
        if (this.openCodeAvailable) {
          logger.info("generateCode: Falling back to OpenCode due to timeout");
          const result = await this.openCodeProvider.generateCode(prompt, context);
          tokenTracker.recordFromText(this.currentPhase, "opencode", inputText, result);
          return result;
        }

        // GLMにフォールバック
        if (this.glmProvider && this.glmAvailable) {
          logger.info("generateCode: Falling back to GLM due to timeout");
          const result = await this.glmProvider.generateCode(prompt, context);
          tokenTracker.recordFromText(this.currentPhase, "glm", inputText, result);
          return result;
        }
      }

      throw err;
    }
  }

  async generateTest(code: string, context: TestContext): Promise<string> {
    const provider = this.getProviderForPhase();
    const inputText = `${code}\n${context.existingTests || ""}`;

    try {
      const result = await provider.generateTest(code, context);

      tokenTracker.recordFromText(this.currentPhase, provider.name, inputText, result);

      return result;
    } catch (err) {
      // タイムアウト時のフォールバック処理
      if (err instanceof Error && this.isTimeoutError(err)) {
        this.recordTimeout();

        // OpenCodeにフォールバック
        if (this.openCodeAvailable) {
          logger.info("generateTest: Falling back to OpenCode due to timeout");
          const result = await this.openCodeProvider.generateTest(code, context);
          tokenTracker.recordFromText(this.currentPhase, "opencode", inputText, result);
          return result;
        }

        // GLMにフォールバック
        if (this.glmProvider && this.glmAvailable) {
          logger.info("generateTest: Falling back to GLM due to timeout");
          const result = await this.glmProvider.generateTest(code, context);
          tokenTracker.recordFromText(this.currentPhase, "glm", inputText, result);
          return result;
        }
      }

      throw err;
    }
  }

  async analyzeCode(code: string): Promise<Analysis> {
    const provider = this.getProviderForPhase();

    try {
      const result = await provider.analyzeCode(code);

      tokenTracker.recordFromText(this.currentPhase, provider.name, code, JSON.stringify(result));

      return result;
    } catch (err) {
      // タイムアウト時のフォールバック処理
      if (err instanceof Error && this.isTimeoutError(err)) {
        this.recordTimeout();

        // OpenCodeにフォールバック
        if (this.openCodeAvailable) {
          logger.info("analyzeCode: Falling back to OpenCode due to timeout");
          const result = await this.openCodeProvider.analyzeCode(code);
          tokenTracker.recordFromText(this.currentPhase, "opencode", code, JSON.stringify(result));
          return result;
        }

        // GLMにフォールバック
        if (this.glmProvider && this.glmAvailable) {
          logger.info("analyzeCode: Falling back to GLM due to timeout");
          const result = await this.glmProvider.analyzeCode(code);
          tokenTracker.recordFromText(this.currentPhase, "glm", code, JSON.stringify(result));
          return result;
        }
      }

      throw err;
    }
  }

  async searchAndAnalyze(query: string, codebase: string[]): Promise<SearchResult> {
    const provider = this.getProviderForPhase();
    const inputText = `${query}\n${codebase.slice(0, 20).join("\n")}`;

    try {
      const result = await provider.searchAndAnalyze(query, codebase);

      tokenTracker.recordFromText(this.currentPhase, provider.name, inputText, JSON.stringify(result));

      return result;
    } catch (err) {
      // タイムアウト時のフォールバック処理
      if (err instanceof Error && this.isTimeoutError(err)) {
        this.recordTimeout();

        // OpenCodeにフォールバック
        if (this.openCodeAvailable) {
          logger.info("searchAndAnalyze: Falling back to OpenCode due to timeout");
          const result = await this.openCodeProvider.searchAndAnalyze(query, codebase);
          tokenTracker.recordFromText(this.currentPhase, "opencode", inputText, JSON.stringify(result));
          return result;
        }

        // GLMにフォールバック
        if (this.glmProvider && this.glmAvailable) {
          logger.info("searchAndAnalyze: Falling back to GLM due to timeout");
          const result = await this.glmProvider.searchAndAnalyze(query, codebase);
          tokenTracker.recordFromText(this.currentPhase, "glm", inputText, JSON.stringify(result));
          return result;
        }
      }

      throw err;
    }
  }

  async chat(prompt: string): Promise<string> {
    const config = getConfig();

    // claudeフェーズでレートリミットフォールバックが有効な場合
    if (
      config.rateLimitFallback.enabled &&
      PHASE_PROVIDER_MAP[this.currentPhase] === "claude"
    ) {
      const { result } = await this.executeWithGLMFallback(
        (provider) => provider.chat(prompt),
        {
          description: `chat: ${prompt.substring(0, 200)}`,
          inputText: prompt,
        }
      );
      return result;
    }

    const provider = this.getProviderForPhase();

    try {
      const result = await provider.chat(prompt);

      tokenTracker.recordFromText(this.currentPhase, provider.name, prompt, result);

      return result;
    } catch (err) {
      // タイムアウト時のフォールバック処理
      if (err instanceof Error && this.isTimeoutError(err)) {
        this.recordTimeout();

        // OpenCodeにフォールバック
        if (this.openCodeAvailable) {
          logger.info("chat: Falling back to OpenCode due to timeout");
          const result = await this.openCodeProvider.chat(prompt);
          tokenTracker.recordFromText(this.currentPhase, "opencode", prompt, result);
          return result;
        }

        // GLMにフォールバック
        if (this.glmProvider && this.glmAvailable) {
          logger.info("chat: Falling back to GLM due to timeout");
          const result = await this.glmProvider.chat(prompt);
          tokenTracker.recordFromText(this.currentPhase, "glm", prompt, result);
          return result;
        }
      }

      throw err;
    }
  }

  async isAvailable(): Promise<boolean> {
    const claudeAvailable = await this.claudeProvider.isAvailable();
    this.openCodeAvailable = await this.openCodeProvider.isAvailable();

    // GLMの可用性チェック
    if (this.glmProvider) {
      try {
        this.glmAvailable = await this.glmProvider.isAvailable();
      } catch {
        this.glmAvailable = false;
      }
    }

    logger.info("Hybrid provider availability check", {
      claude: claudeAvailable,
      opencode: this.openCodeAvailable,
      glm: this.glmAvailable,
    });

    // Claudeまたは（GLM + OpenCode）が使えればOK
    return claudeAvailable || (this.glmAvailable && this.openCodeAvailable) || this.openCodeAvailable;
  }

  /**
   * レートリミット状態を取得
   */
  getRateLimitState(): RateLimitState {
    return { ...this.rateLimitState };
  }

  /**
   * タイムアウト状態を取得
   */
  getTimeoutState(): TimeoutState {
    return { ...this.timeoutState };
  }

  /**
   * GLM変更の統計を取得
   */
  getGLMChangeStats(): ReturnType<ChangeTracker["getStats"]> {
    return this.changeTracker.getStats();
  }

  /**
   * 古い変更をクリーンアップ
   */
  cleanupOldChanges(maxAgeDays: number = 30): number {
    return this.changeTracker.cleanup(maxAgeDays);
  }
}
```
[<u[?1004l[?2004l[?25h[?25h