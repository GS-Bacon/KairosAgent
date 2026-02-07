/**
 * Resilient AI Provider
 *
 * AIプロバイダーのProxy層で、レートリミット/タイムアウト時に自動的にGLMにフォールバック
 * 全メソッドに透過的フォールバック適用
 */

import {
  AIProvider,
  CodeContext,
  TestContext,
  Analysis,
  SearchResult,
} from "./provider.js";
import { GLMProvider } from "./glm-provider.js";
import { logger } from "../core/logger.js";
import { changeTracker } from "./change-tracker.js";
import { confirmationQueue } from "./confirmation-queue.js";
import { RateLimitHandler } from "./rate-limit-handler.js";
import { RATE_LIMIT } from "../config/constants.js";

export class ResilientAIProvider implements AIProvider {
  name: string;
  private primaryProvider: AIProvider;
  private fallbackProvider: GLMProvider | null;
  private rateLimitHandler: RateLimitHandler;
  private currentPhase: string = "unknown";

  constructor(primaryProvider: AIProvider, glmApiKey?: string) {
    this.primaryProvider = primaryProvider;
    this.name = `resilient-${primaryProvider.name}`;
    this.rateLimitHandler = new RateLimitHandler({
      baseBackoffMs: RATE_LIMIT.BASE_BACKOFF_MS,
      maxBackoffMs: RATE_LIMIT.MAX_BACKOFF_MS,
      circuitBreakerThreshold: RATE_LIMIT.CIRCUIT_BREAKER_THRESHOLD,
    });

    // GLM API keyがあればフォールバックプロバイダーを作成
    if (glmApiKey) {
      this.fallbackProvider = new GLMProvider({ apiKey: glmApiKey });
      logger.info("Resilient provider initialized with GLM fallback");
    } else {
      this.fallbackProvider = null;
      logger.info("Resilient provider initialized without fallback (no GLM API key)");
    }
  }

  setCurrentPhase(phase: string): void {
    this.currentPhase = phase;
  }

  /**
   * フォールバック付きで操作を実行
   */
  private async executeWithFallback<T>(
    primaryOp: () => Promise<T>,
    fallbackOp: () => Promise<T>,
    context: { operation: string; inputSummary?: string }
  ): Promise<T> {
    // プライマリがレートリミット中ならフォールバック直行
    if (this.rateLimitHandler.isCurrentlyLimited() && this.fallbackProvider) {
      logger.debug("Using fallback provider (rate limited)", {
        operation: context.operation,
        phase: this.currentPhase,
      });
      return this.executeWithTracking(fallbackOp, context);
    }

    try {
      const result = await primaryOp();
      this.rateLimitHandler.recordSuccess();
      return result;
    } catch (error) {
      if (this.rateLimitHandler.isRetryableError(error) && this.fallbackProvider) {
        this.rateLimitHandler.recordRateLimit();
        logger.info("Falling back to GLM due to retryable error", {
          operation: context.operation,
          phase: this.currentPhase,
        });
        return this.executeWithTracking(fallbackOp, context);
      }

      if (this.rateLimitHandler.isRetryableError(error) && !this.fallbackProvider) {
        this.rateLimitHandler.recordRateLimit();
        throw new Error(`Primary provider error and no fallback available: ${error instanceof Error ? error.message : String(error)}`);
      }

      throw error;
    }
  }

  private async executeWithTracking<T>(
    fallbackOp: () => Promise<T>,
    context: { operation: string; inputSummary?: string }
  ): Promise<T> {
    const result = await fallbackOp();

    const changeId = changeTracker.recordChange({
      timestamp: new Date().toISOString(),
      phase: this.currentPhase,
      provider: "glm",
      files: [],
      description: `GLM fallback: ${context.operation}`,
    });

    await confirmationQueue.addFromChange(changeId, RATE_LIMIT.FALLBACK_CONFIRMATION_PRIORITY);

    return result;
  }

  // === AIProvider インターフェース実装 ===

  async generateCode(prompt: string, context: CodeContext): Promise<string> {
    return this.executeWithFallback(
      () => this.primaryProvider.generateCode(prompt, context),
      () => this.fallbackProvider!.generateCode(prompt, context),
      { operation: "generateCode", inputSummary: context.file }
    );
  }

  async generateTest(code: string, context: TestContext): Promise<string> {
    return this.executeWithFallback(
      () => this.primaryProvider.generateTest(code, context),
      () => this.fallbackProvider!.generateTest(code, context),
      { operation: "generateTest", inputSummary: context.targetFile }
    );
  }

  async analyzeCode(code: string): Promise<Analysis> {
    return this.executeWithFallback(
      () => this.primaryProvider.analyzeCode(code),
      () => this.fallbackProvider!.analyzeCode(code),
      { operation: "analyzeCode" }
    );
  }

  async searchAndAnalyze(query: string, codebase: string[]): Promise<SearchResult> {
    return this.executeWithFallback(
      () => this.primaryProvider.searchAndAnalyze(query, codebase),
      () => this.fallbackProvider!.searchAndAnalyze(query, codebase),
      { operation: "searchAndAnalyze", inputSummary: query }
    );
  }

  async chat(prompt: string): Promise<string> {
    return this.executeWithFallback(
      () => this.primaryProvider.chat(prompt),
      () => this.fallbackProvider!.chat(prompt),
      { operation: "chat" }
    );
  }

  async isAvailable(): Promise<boolean> {
    const primaryAvailable = await this.primaryProvider.isAvailable();
    if (primaryAvailable) return true;

    if (this.fallbackProvider) {
      return this.fallbackProvider.isAvailable();
    }
    return false;
  }

  getRateLimitState() {
    return this.rateLimitHandler.getState();
  }

  clearRateLimit(): void {
    this.rateLimitHandler.clear();
    logger.info("Rate limit state cleared manually");
  }
}
