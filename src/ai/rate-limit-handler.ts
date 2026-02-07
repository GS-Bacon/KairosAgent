/**
 * Rate Limit Handler
 *
 * レートリミット/タイムアウト検出、指数バックオフ、Circuit Breaker の共通ロジック
 * ResilientAIProvider と HybridProvider で共有
 */

import { logger } from "../core/logger.js";

export interface RateLimitHandlerConfig {
  baseBackoffMs: number;
  maxBackoffMs: number;
  circuitBreakerThreshold: number;
}

type CircuitState = "closed" | "open" | "half-open";

export class RateLimitHandler {
  private isLimited: boolean = false;
  private limitedAt?: Date;
  private retryAfter?: number;
  private consecutiveFailures: number = 0;
  private circuitState: CircuitState = "closed";
  private lastFailureAt?: Date;
  private config: RateLimitHandlerConfig;

  constructor(config: RateLimitHandlerConfig) {
    this.config = config;
  }

  /**
   * リトライ可能なエラーかどうか判定（レートリミット + タイムアウト）
   */
  isRetryableError(error: unknown): boolean {
    const message = (error instanceof Error ? error.message : String(error)).toLowerCase();
    return (
      message.includes("rate limit") ||
      message.includes("429") ||
      message.includes("too many requests") ||
      message.includes("overloaded") ||
      message.includes("capacity") ||
      message.includes("timeout") ||
      message.includes("etimedout") ||
      message.includes("econnreset")
    );
  }

  /**
   * レートリミットを記録（指数バックオフ付き）
   */
  recordRateLimit(): void {
    this.consecutiveFailures++;
    this.isLimited = true;
    this.limitedAt = new Date();
    this.lastFailureAt = new Date();

    const backoff = Math.min(
      this.config.baseBackoffMs * Math.pow(2, this.consecutiveFailures - 1),
      this.config.maxBackoffMs,
    );
    this.retryAfter = backoff;

    if (this.consecutiveFailures >= this.config.circuitBreakerThreshold) {
      this.circuitState = "open";
      logger.warn("Circuit breaker opened", {
        consecutiveFailures: this.consecutiveFailures,
        backoffMs: backoff,
      });
    }

    logger.warn("Rate limit recorded", {
      retryAfter: backoff,
      consecutiveFailures: this.consecutiveFailures,
      circuitState: this.circuitState,
    });
  }

  /**
   * 現在レートリミット中かチェック
   */
  isCurrentlyLimited(): boolean {
    if (!this.isLimited) return false;

    if (this.retryAfter && this.limitedAt) {
      const elapsed = Date.now() - this.limitedAt.getTime();
      if (elapsed > this.retryAfter) {
        this.isLimited = false;
        logger.info("Rate limit window expired, resuming");
        return false;
      }
    }

    return true;
  }

  /**
   * 成功を記録（circuit breaker リセット）
   */
  recordSuccess(): void {
    if (this.consecutiveFailures > 0) {
      logger.info("Provider recovered", {
        previousFailures: this.consecutiveFailures,
      });
    }
    this.consecutiveFailures = 0;
    this.circuitState = "closed";
    this.isLimited = false;
  }

  /**
   * 状態をクリア（手動復旧用）
   */
  clear(): void {
    this.isLimited = false;
    this.consecutiveFailures = 0;
    this.circuitState = "closed";
    this.limitedAt = undefined;
    this.retryAfter = undefined;
    this.lastFailureAt = undefined;
  }

  /**
   * 状態を取得（デバッグ用）
   */
  getState(): {
    isLimited: boolean;
    consecutiveFailures: number;
    circuitState: CircuitState;
    backoffUntil?: Date;
  } {
    const backoffUntil = this.limitedAt && this.retryAfter
      ? new Date(this.limitedAt.getTime() + this.retryAfter)
      : undefined;

    return {
      isLimited: this.isLimited,
      consecutiveFailures: this.consecutiveFailures,
      circuitState: this.circuitState,
      backoffUntil,
    };
  }
}
