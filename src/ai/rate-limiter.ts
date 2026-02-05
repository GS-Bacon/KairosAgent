/**
 * Rate Limiter for AI Provider Calls
 *
 * API呼び出しの頻度制限を管理
 */

import { logger } from "../core/logger.js";

export interface RateLimiterConfig {
  minInterval: number;      // 最小呼び出し間隔（ミリ秒）
  maxConcurrent?: number;   // 最大同時呼び出し数（オプション）
  burstLimit?: number;      // バースト許容数（オプション）
}

export class RateLimiter {
  private lastCall: number = 0;
  private minInterval: number;
  private maxConcurrent: number;
  private currentConcurrent: number = 0;
  private burstLimit: number;
  private burstCount: number = 0;
  private burstResetTime: number = 0;

  constructor(config: RateLimiterConfig = { minInterval: 1000 }) {
    this.minInterval = config.minInterval;
    this.maxConcurrent = config.maxConcurrent || 5;
    this.burstLimit = config.burstLimit || 10;
  }

  /**
   * 呼び出し前にスロットル
   * 必要に応じて待機
   */
  async throttle(): Promise<void> {
    const now = Date.now();

    // バーストカウントリセット（1分ごと）
    if (now - this.burstResetTime > 60000) {
      this.burstCount = 0;
      this.burstResetTime = now;
    }

    // バーストリミット超過
    if (this.burstCount >= this.burstLimit) {
      const waitTime = 60000 - (now - this.burstResetTime);
      if (waitTime > 0) {
        logger.warn("Burst limit reached, waiting", {
          waitTime,
          burstCount: this.burstCount,
          burstLimit: this.burstLimit,
        });
        await this.sleep(waitTime);
        this.burstCount = 0;
        this.burstResetTime = Date.now();
      }
    }

    // 同時呼び出し数チェック
    while (this.currentConcurrent >= this.maxConcurrent) {
      await this.sleep(100);
    }

    // 最小間隔待機
    const elapsed = now - this.lastCall;
    if (elapsed < this.minInterval) {
      const waitTime = this.minInterval - elapsed;
      await this.sleep(waitTime);
    }

    this.lastCall = Date.now();
    this.burstCount++;
  }

  /**
   * 呼び出し開始（同時呼び出し数トラッキング用）
   */
  acquire(): void {
    this.currentConcurrent++;
  }

  /**
   * 呼び出し終了（同時呼び出し数トラッキング用）
   */
  release(): void {
    this.currentConcurrent = Math.max(0, this.currentConcurrent - 1);
  }

  /**
   * スロットル付きで関数を実行
   */
  async execute<T>(fn: () => Promise<T>): Promise<T> {
    await this.throttle();
    this.acquire();
    try {
      return await fn();
    } finally {
      this.release();
    }
  }

  /**
   * 最小間隔を設定
   */
  setInterval(ms: number): void {
    this.minInterval = Math.max(0, ms);
    logger.debug("Rate limiter interval updated", { minInterval: this.minInterval });
  }

  /**
   * 現在の状態を取得
   */
  getStatus(): {
    minInterval: number;
    maxConcurrent: number;
    currentConcurrent: number;
    burstCount: number;
    burstLimit: number;
    lastCall: number;
  } {
    return {
      minInterval: this.minInterval,
      maxConcurrent: this.maxConcurrent,
      currentConcurrent: this.currentConcurrent,
      burstCount: this.burstCount,
      burstLimit: this.burstLimit,
      lastCall: this.lastCall,
    };
  }

  /**
   * 429エラー時に間隔を延長
   */
  backoffOnRateLimit(multiplier: number = 2): void {
    const newInterval = Math.min(this.minInterval * multiplier, 60000); // 最大60秒
    this.minInterval = newInterval;
    logger.warn("Rate limit detected, increasing interval", {
      newInterval: this.minInterval,
    });
  }

  /**
   * 成功時に間隔を短縮（最小値まで）
   */
  decreaseInterval(originalInterval: number): void {
    this.minInterval = Math.max(originalInterval, this.minInterval / 2);
  }

  private sleep(ms: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }
}

// プロバイダーごとのレートリミッター
const rateLimiters: Map<string, RateLimiter> = new Map();

/**
 * プロバイダー用のレートリミッターを取得または作成
 */
export function getRateLimiter(providerName: string, config?: RateLimiterConfig): RateLimiter {
  let limiter = rateLimiters.get(providerName);
  if (!limiter) {
    limiter = new RateLimiter(config);
    rateLimiters.set(providerName, limiter);
  }
  return limiter;
}

/**
 * 全レートリミッターをリセット
 */
export function resetAllRateLimiters(): void {
  rateLimiters.clear();
}
