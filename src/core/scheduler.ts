import { logger } from "./logger.js";
import { CycleResult } from "../phases/types.js";
import { RETRY } from "../config/constants.js";

/**
 * 即時再実行の状態管理
 */
export interface RetryState {
  consecutiveFailures: number;   // 連続失敗回数
  maxRetries: number;            // 上限（デフォルト: 3）
  lastFailureReason?: string;    // 前回の失敗理由
  lastErrorCategory?: string;    // 前回のエラーカテゴリ
  cooldownUntil?: Date;          // クールダウン終了時刻
}

export interface ScheduledTask {
  id: string;
  name: string;
  interval: number;
  handler: () => Promise<CycleResult | void>;
  lastRun?: Date;
  nextRun?: Date;
  isRunning: boolean;
}

export class Scheduler {
  private tasks: Map<string, ScheduledTask> = new Map();
  private timers: Map<string, NodeJS.Timeout> = new Map();
  private isRunning: boolean = false;
  private retryState: RetryState = {
    consecutiveFailures: 0,
    maxRetries: RETRY.MAX_RETRIES,
  };
  private retryTimer: NodeJS.Timeout | null = null;

  register(
    id: string,
    name: string,
    interval: number,
    handler: () => Promise<CycleResult | void>
  ): void {
    if (this.tasks.has(id)) {
      logger.warn(`Task ${id} already registered, replacing`);
      this.unregister(id);
    }

    this.tasks.set(id, {
      id,
      name,
      interval,
      handler,
      isRunning: false,
    });

    logger.info(`Registered task: ${name}`, { id, interval });
  }

  unregister(id: string): void {
    const timer = this.timers.get(id);
    if (timer) {
      clearInterval(timer);
      this.timers.delete(id);
    }
    this.tasks.delete(id);
    logger.info(`Unregistered task: ${id}`);
  }

  private async runTask(task: ScheduledTask): Promise<void> {
    if (task.isRunning) {
      // ゴーストロック検知: lastRunが存在しない場合（初回実行中stuck）も対応
      const stuckThreshold = task.interval * 3;
      const lastRunTime = task.lastRun?.getTime() || 0;
      const elapsed = Date.now() - lastRunTime;

      if (elapsed > stuckThreshold) {
        logger.warn(`Task ${task.name} appears stuck (ghost lock detected), forcing reset`, {
          lastRun: task.lastRun?.toISOString() || "never",
          elapsedMs: elapsed,
          thresholdMs: stuckThreshold,
        });
        task.isRunning = false;
      } else {
        logger.warn(`Task ${task.name} is already running, skipping`);
        return;
      }
    }

    task.isRunning = true;
    task.lastRun = new Date();

    let result: CycleResult | void = undefined;

    try {
      logger.debug(`Running task: ${task.name}`);
      result = await task.handler();
      logger.debug(`Task completed: ${task.name}`);
    } catch (err) {
      const errorMessage = err instanceof Error ? err.message : String(err);
      logger.error(`Task failed: ${task.name}`, { error: errorMessage });
    } finally {
      task.isRunning = false;
      task.nextRun = new Date(Date.now() + task.interval);
    }

    // CycleResult が返された場合、即時再実行を判定
    if (result && this.isCycleResult(result)) {
      await this.handleCycleResult(task, result);
    }
  }

  /**
   * CycleResult かどうかを判定
   */
  private isCycleResult(result: unknown): result is CycleResult {
    return (
      typeof result === "object" &&
      result !== null &&
      "cycleId" in result &&
      "shouldRetry" in result
    );
  }

  /**
   * エラーカテゴリを抽出
   * 異なるメッセージでも根本原因が同じ場合を識別
   */
  private extractErrorCategory(reason: string | undefined): string {
    if (!reason) return "unknown";

    // カテゴリパターンのマッチング
    const patterns: [RegExp, string][] = [
      [/build\s*fail|compilation\s*error|tsc\s*error/i, "build-error"],
      [/test\s*fail|assertion\s*error|expect/i, "test-failure"],
      [/type\s*error|ts\d{4}/i, "type-error"],
      [/syntax\s*error|unexpected\s*token/i, "syntax-error"],
      [/module\s*not\s*found|cannot\s*find\s*module/i, "dependency-error"],
      [/timeout|timed?\s*out/i, "timeout"],
      [/rate\s*limit|429|too\s*many\s*requests/i, "rate-limit"],
      [/network|connection|econnrefused/i, "network-error"],
      [/permission|eacces|forbidden/i, "permission-error"],
    ];

    for (const [pattern, category] of patterns) {
      if (pattern.test(reason)) {
        return category;
      }
    }

    return "unknown";
  }

  /**
   * サイクル結果に基づいて即時再実行を処理
   */
  private async handleCycleResult(task: ScheduledTask, result: CycleResult): Promise<void> {
    if (result.success) {
      // 成功時はリトライ状態をリセット
      this.retryState.consecutiveFailures = 0;
      this.retryState.lastFailureReason = undefined;
      this.retryState.lastErrorCategory = undefined;
      logger.debug("Cycle succeeded, retry state reset");
      return;
    }

    // 失敗した場合
    if (!result.shouldRetry) {
      logger.debug("Cycle failed but retry not requested");
      return;
    }

    // エラーカテゴリを抽出
    const currentCategory = this.extractErrorCategory(result.retryReason);

    // 同じ理由で連続失敗している場合は即座にクールダウン
    if (this.retryState.lastFailureReason === result.retryReason) {
      logger.warn("Same failure reason repeated, entering cooldown immediately", {
        reason: result.retryReason,
      });
      this.enterCooldown();
      return;
    }

    // 同じエラーカテゴリで連続失敗している場合も即座にクールダウン
    if (
      this.retryState.lastErrorCategory &&
      this.retryState.lastErrorCategory === currentCategory &&
      currentCategory !== "unknown"
    ) {
      logger.warn("Same error category repeated, entering cooldown immediately", {
        category: currentCategory,
        previousReason: this.retryState.lastFailureReason,
        currentReason: result.retryReason,
      });
      this.enterCooldown();
      return;
    }

    // 先にインクリメントしてからリトライ可能かチェック
    this.retryState.consecutiveFailures++;
    this.retryState.lastFailureReason = result.retryReason;
    this.retryState.lastErrorCategory = currentCategory;

    // リトライ可能かチェック
    if (!this.canRetry()) {
      logger.info("Cannot retry, in cooldown or max retries reached");
      return;
    }

    // Exponential backoff: 5秒 × 2^(failures-1)、最大10分
    const backoffMs = this.calculateBackoff(this.retryState.consecutiveFailures);

    logger.info("Scheduling immediate retry with backoff", {
      reason: result.retryReason,
      category: currentCategory,
      consecutiveFailures: this.retryState.consecutiveFailures,
      maxRetries: this.retryState.maxRetries,
      backoffMs,
    });

    this.retryTimer = setTimeout(() => {
      this.retryTimer = null;
      this.runTask(task);
    }, backoffMs);
  }

  /**
   * Exponential backoff を計算
   * 5秒 × 2^(failures-1)、最大10分
   */
  private calculateBackoff(failures: number): number {
    const baseMs = RETRY.SCHEDULER_BASE_BACKOFF_MS;
    const maxMs = RETRY.SCHEDULER_MAX_BACKOFF_MS;
    const backoff = baseMs * Math.pow(2, failures - 1);
    return Math.min(backoff, maxMs);
  }

  /**
   * リトライ可能かどうかを判定
   */
  private canRetry(): boolean {
    // クールダウン中かチェック
    if (this.retryState.cooldownUntil && new Date() < this.retryState.cooldownUntil) {
      logger.debug("In cooldown period", {
        cooldownUntil: this.retryState.cooldownUntil,
      });
      return false;
    }

    // 最大リトライ回数に達したかチェック（インクリメント済みの値で比較）
    if (this.retryState.consecutiveFailures >= this.retryState.maxRetries) {
      this.enterCooldown();
      return false;
    }

    return true;
  }

  /**
   * クールダウン期間に入る
   */
  private enterCooldown(): void {
    const cooldownMs = RETRY.SCHEDULER_COOLDOWN_MS;
    this.retryState.cooldownUntil = new Date(Date.now() + cooldownMs);
    logger.warn("Max retries reached, entering cooldown", {
      cooldownUntil: this.retryState.cooldownUntil,
      cooldownMinutes: cooldownMs / 60000,
      lastFailureReason: this.retryState.lastFailureReason,
      lastErrorCategory: this.retryState.lastErrorCategory,
      consecutiveFailures: this.retryState.consecutiveFailures,
    });
    this.retryState.consecutiveFailures = 0; // リセット
  }

  start(): void {
    if (this.isRunning) {
      logger.warn("Scheduler already running");
      return;
    }

    this.isRunning = true;
    logger.info("Starting scheduler");

    for (const task of this.tasks.values()) {
      this.runTask(task);

      const timer = setInterval(() => {
        this.runTask(task).catch((err) => {
          logger.error(`Scheduled task ${task.name} unhandled error`, {
            error: err instanceof Error ? err.message : String(err),
          });
        });
      }, task.interval);

      this.timers.set(task.id, timer);
    }
  }

  stop(): void {
    if (!this.isRunning) return;

    logger.info("Stopping scheduler");

    for (const timer of this.timers.values()) {
      clearInterval(timer);
    }
    this.timers.clear();

    // リトライタイマーもクリア
    if (this.retryTimer) {
      clearTimeout(this.retryTimer);
      this.retryTimer = null;
    }

    this.isRunning = false;
  }

  async runNow(id: string): Promise<void> {
    const task = this.tasks.get(id);
    if (!task) {
      throw new Error(`Task not found: ${id}`);
    }
    await this.runTask(task);
  }

  getStatus(): {
    tasks: ScheduledTask[];
    isRunning: boolean;
    retryState: RetryState;
  } {
    return {
      tasks: Array.from(this.tasks.values()),
      isRunning: this.isRunning,
      retryState: { ...this.retryState },
    };
  }

  /**
   * リトライ状態をリセット（テスト用）
   */
  resetRetryState(): void {
    this.retryState = {
      consecutiveFailures: 0,
      maxRetries: RETRY.MAX_RETRIES,
      lastFailureReason: undefined,
      lastErrorCategory: undefined,
      cooldownUntil: undefined,
    };
    if (this.retryTimer) {
      clearTimeout(this.retryTimer);
      this.retryTimer = null;
    }
    logger.debug("Retry state reset");
  }
}

export const scheduler = new Scheduler();