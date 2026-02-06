/**
 * Resilient AI Provider
 *
 * AIプロバイダーのProxy層で、レートリミット時に自動的にGLMにフォールバック
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

interface RateLimitState {
  isRateLimited: boolean;
  limitedAt?: Date;
  retryAfter?: number;  // ms
}

export class ResilientAIProvider implements AIProvider {
  name: string;
  private primaryProvider: AIProvider;
  private fallbackProvider: GLMProvider | null;
  private rateLimitState: RateLimitState = { isRateLimited: false };
  private currentPhase: string = "unknown";

  constructor(primaryProvider: AIProvider, glmApiKey?: string) {
    this.primaryProvider = primaryProvider;
    this.name = `resilient-${primaryProvider.name}`;

    // GLM API keyがあればフォールバックプロバイダーを作成
    if (glmApiKey) {
      this.fallbackProvider = new GLMProvider({ apiKey: glmApiKey });
      logger.info("Resilient provider initialized with GLM fallback");
    } else {
      this.fallbackProvider = null;
      logger.info("Resilient provider initialized without fallback (no GLM API key)");
    }
  }

  /**
   * 現在のフェーズを設定（ログ用）
   */
  setCurrentPhase(phase: string): void {
    this.currentPhase = phase;
  }

  /**
   * プライマリプロバイダーがレートリミット中かチェック
   */
  private isPrimaryRateLimited(): boolean {
    if (!this.rateLimitState.isRateLimited) {
      return false;
    }

    // リトライ時間を過ぎていれば解除
    if (this.rateLimitState.retryAfter && this.rateLimitState.limitedAt) {
      const elapsed = Date.now() - this.rateLimitState.limitedAt.getTime();
      if (elapsed > this.rateLimitState.retryAfter) {
        this.rateLimitState.isRateLimited = false;
        logger.info("Rate limit window expired, resuming primary provider");
        return false;
      }
    }

    return true;
  }

  /**
   * レートリミットを記録
   */
  private recordRateLimit(retryAfterMs: number = 60000): void {
    this.rateLimitState = {
      isRateLimited: true,
      limitedAt: new Date(),
      retryAfter: retryAfterMs,
    };
    logger.warn("Primary provider rate limited", {
      retryAfter: retryAfterMs,
      provider: this.primaryProvider.name,
    });
  }

  /**
   * エラーがレートリミットかどうか判定
   */
  private isRateLimitError(error: unknown): boolean {
    if (!(error instanceof Error)) return false;
    const message = error.message.toLowerCase();
    return (
      message.includes("rate limit") ||
      message.includes("429") ||
      message.includes("too many requests") ||
      message.includes("overloaded")
    );
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
    if (this.isPrimaryRateLimited() && this.fallbackProvider) {
      logger.debug("Using fallback provider (rate limited)", {
        operation: context.operation,
        phase: this.currentPhase,
      });
      return this.executeWithTracking(fallbackOp, context);
    }

    try {
      return await primaryOp();
    } catch (error) {
      // レートリミットエラーの場合、フォールバック
      if (this.isRateLimitError(error) && this.fallbackProvider) {
        this.recordRateLimit();
        logger.info("Falling back to GLM due to rate limit", {
          operation: context.operation,
          phase: this.currentPhase,
        });
        return this.executeWithTracking(fallbackOp, context);
      }

      // その他のエラーはそのまま投げる
      throw error;
    }
  }

  /**
   * フォールバック操作を追跡付きで実行
   */
  private async executeWithTracking<T>(
    fallbackOp: () => Promise<T>,
    context: { operation: string; inputSummary?: string }
  ): Promise<T> {
    const result = await fallbackOp();

    // 変更を記録
    const changeId = changeTracker.recordChange({
      timestamp: new Date().toISOString(),
      phase: this.currentPhase,
      provider: "glm",
      files: [],  // 具体的なファイルは呼び出し元で設定
      description: `GLM fallback: ${context.operation}`,
    });

    // 確認キューに追加
    await confirmationQueue.addFromChange(changeId, 50);  // 中優先度

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
    // プライマリかフォールバックのどちらかが利用可能ならtrue
    const primaryAvailable = await this.primaryProvider.isAvailable();
    if (primaryAvailable) return true;

    if (this.fallbackProvider) {
      return this.fallbackProvider.isAvailable();
    }
    return false;
  }

  /**
   * レートリミット状態を取得（デバッグ用）
   */
  getRateLimitState(): RateLimitState {
    return { ...this.rateLimitState };
  }

  /**
   * レートリミットをクリア（手動復旧用）
   */
  clearRateLimit(): void {
    this.rateLimitState = { isRateLimited: false };
    logger.info("Rate limit state cleared manually");
  }
}
