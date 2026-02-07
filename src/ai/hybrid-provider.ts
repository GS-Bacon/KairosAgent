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
import { getConfig } from "../config/config.js";
import { ChangeTracker, changeTracker } from "./change-tracker.js";
import { ClaudeReviewer, claudeReviewer } from "./claude-reviewer.js";
import { getRateLimiter } from "./rate-limiter.js";
import { tokenTracker } from "./token-tracker.js";
import { RateLimitHandler } from "./rate-limit-handler.js";
import { HYBRID_PROVIDER } from "../config/constants.js";

export type PhaseName =
  | "health-check"
  | "error-detect"
  | "improve-find"
  | "search"
  | "plan"
  | "implement"
  | "test-gen"
  | "verify";

/**
 * フェーズごとのプロバイダーマッピング
 * Claude: 重要な判断・高品質コード生成（plan, implement）
 * OpenCode: 探索・検証（health-check, error-detect, search等）
 */
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
  private rateLimitHandler: RateLimitHandler;

  constructor() {
    this.claudeProvider = new ClaudeProvider();
    this.openCodeProvider = new OpenCodeProvider();
    this.changeTracker = changeTracker;
    this.reviewer = claudeReviewer;
    this.rateLimitHandler = new RateLimitHandler({
      baseBackoffMs: HYBRID_PROVIDER.BASE_BACKOFF_MS,
      maxBackoffMs: HYBRID_PROVIDER.MAX_BACKOFF_MS,
      circuitBreakerThreshold: 3,
    });

    this.initializeGLM();
  }

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
   * Claudeが利用可能かチェック（レートリミット考慮）
   */
  private async isClaudeAvailable(): Promise<boolean> {
    if (this.rateLimitHandler.isCurrentlyLimited()) {
      logger.debug("Claude still in rate limit backoff");
      return false;
    }

    try {
      const available = await this.claudeProvider.isAvailable();
      if (available) {
        this.rateLimitHandler.recordSuccess();
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
        await this.reviewPendingGLMChanges();

        const result = await operation(this.claudeProvider);

        if (context.inputText) {
          const outputText = typeof result === "string" ? result : JSON.stringify(result);
          tokenTracker.recordFromText(this.currentPhase, "claude", context.inputText, outputText);
        }

        return { result, usedProvider: "claude" };
      } catch (err) {
        if (err instanceof Error && this.rateLimitHandler.isRetryableError(err)) {
          this.rateLimitHandler.recordRateLimit();
          const limiter = getRateLimiter("claude");
          limiter.backoffOnRateLimit(2);
        } else {
          throw err;
        }
      }
    }

    // GLMにフォールバック
    if (!this.glmProvider || !this.glmAvailable) {
      throw new Error("Claude rate limited and GLM not available");
    }

    logger.info("Falling back to GLM", { phase: this.currentPhase });

    const result = await operation(this.glmProvider);

    if (context.inputText) {
      const outputText = typeof result === "string" ? result : JSON.stringify(result);
      tokenTracker.recordFromText(this.currentPhase, "glm", context.inputText, outputText);
    }

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

  private async reviewPendingGLMChanges(): Promise<void> {
    const config = getConfig();

    if (!config.rateLimitFallback.autoReview) {
      return;
    }

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
    const result = await provider.generateCode(prompt, context);

    tokenTracker.recordFromText(this.currentPhase, provider.name, inputText, result);

    return result;
  }

  async generateTest(code: string, context: TestContext): Promise<string> {
    const provider = this.getProviderForPhase();
    const inputText = `${code}\n${context.existingTests || ""}`;
    const result = await provider.generateTest(code, context);

    tokenTracker.recordFromText(this.currentPhase, provider.name, inputText, result);

    return result;
  }

  async analyzeCode(code: string): Promise<Analysis> {
    const provider = this.getProviderForPhase();
    const result = await provider.analyzeCode(code);

    tokenTracker.recordFromText(this.currentPhase, provider.name, code, JSON.stringify(result));

    return result;
  }

  async searchAndAnalyze(query: string, codebase: string[]): Promise<SearchResult> {
    const provider = this.getProviderForPhase();
    const inputText = `${query}\n${codebase.slice(0, 20).join("\n")}`;
    const result = await provider.searchAndAnalyze(query, codebase);

    tokenTracker.recordFromText(this.currentPhase, provider.name, inputText, JSON.stringify(result));

    return result;
  }

  async chat(prompt: string): Promise<string> {
    const config = getConfig();

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
    const result = await provider.chat(prompt);

    tokenTracker.recordFromText(this.currentPhase, provider.name, prompt, result);

    return result;
  }

  async isAvailable(): Promise<boolean> {
    const claudeAvailable = await this.claudeProvider.isAvailable();
    this.openCodeAvailable = await this.openCodeProvider.isAvailable();

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

    return claudeAvailable || (this.glmAvailable && this.openCodeAvailable);
  }

  getRateLimitState() {
    return this.rateLimitHandler.getState();
  }

  getGLMChangeStats(): ReturnType<ChangeTracker["getStats"]> {
    return this.changeTracker.getStats();
  }

  cleanupOldChanges(maxAgeDays: number = 30): number {
    return this.changeTracker.cleanup(maxAgeDays);
  }
}
