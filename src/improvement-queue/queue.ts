/**
 * Improvement Queue
 *
 * 改善提案を優先度付きキューで管理
 */

import { readFile } from "fs/promises";
import { existsSync } from "fs";
import { join } from "path";
import { atomicWriteFile } from "../utils/atomic-write.js";
import { safeJsonParse } from "../utils/safe-json.js";
import { QueueStoreSchema } from "../utils/schemas.js";
import { STORAGE } from "../config/constants.js";

import {
  QueuedImprovement,
  QueuedImprovementInput,
  QueueStore,
  QueueStats,
  QueueFilter,
  ImprovementStatus,
  ImprovementSource,
  ImprovementType,
} from "./types.js";
import { logger } from "../core/logger.js";

const QUEUE_FILE = join(process.cwd(), "workspace", "improvement-queue.json");

class ImprovementQueue {
  private queue: QueuedImprovement[] = [];
  private loaded: boolean = false;
  private loadingPromise: Promise<void> | null = null;

  async load(): Promise<void> {
    if (this.loaded) return;
    if (this.loadingPromise) return this.loadingPromise;

    this.loadingPromise = this._doLoad();
    try {
      await this.loadingPromise;
    } finally {
      this.loadingPromise = null;
    }
  }

  private async _doLoad(): Promise<void> {
    try {
      if (existsSync(QUEUE_FILE)) {
        const content = await readFile(QUEUE_FILE, "utf-8");
        const store = safeJsonParse(content, QueueStoreSchema, "improvement-queue.json");
        this.queue = store?.queue || [];
      }
    } catch (error) {
      logger.warn("Failed to load improvement-queue.json, starting fresh:", { error });
      this.queue = [];
    }

    this.loaded = true;
  }

  async save(): Promise<void> {
    const store: QueueStore = {
      version: 1,
      queue: this.queue,
      lastUpdated: new Date().toISOString(),
    };

    await atomicWriteFile(QUEUE_FILE, JSON.stringify(store, null, 2));
  }

  /**
   * 改善提案をキューに追加
   */
  async enqueue(input: QueuedImprovementInput): Promise<QueuedImprovement> {
    await this.load();

    const now = new Date().toISOString();
    const improvement: QueuedImprovement = {
      id: `imp_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`,
      source: input.source,
      type: input.type,
      title: input.title,
      description: input.description,
      priority: input.priority ?? STORAGE.DEFAULT_IMPROVEMENT_PRIORITY,
      status: "pending",
      metadata: input.metadata,
      relatedFile: input.relatedFile,
      relatedTroubleIds: input.relatedTroubleIds,
      relatedPatternId: input.relatedPatternId,
      preventionSuggestionId: input.preventionSuggestionId,
      createdAt: now,
      updatedAt: now,
    };

    this.queue.push(improvement);
    await this.save();

    logger.debug("Enqueued improvement", {
      id: improvement.id,
      title: improvement.title,
      priority: improvement.priority,
    });

    return improvement;
  }

  /**
   * 複数の改善提案を一括追加
   */
  async enqueueBatch(inputs: QueuedImprovementInput[]): Promise<QueuedImprovement[]> {
    const improvements: QueuedImprovement[] = [];
    for (const input of inputs) {
      const imp = await this.enqueue(input);
      improvements.push(imp);
    }
    return improvements;
  }

  /**
   * 次に処理すべき改善提案を取得（優先度順）
   */
  async dequeue(count: number = 1): Promise<QueuedImprovement[]> {
    await this.load();

    const pending = this.queue
      .filter((i) => i.status === "pending")
      .sort((a, b) => b.priority - a.priority)
      .slice(0, count);

    // スケジュール済みとしてマーク
    for (const imp of pending) {
      imp.status = "scheduled";
      imp.scheduledFor = new Date().toISOString();
      imp.updatedAt = new Date().toISOString();
    }

    await this.save();
    return pending;
  }

  /**
   * 改善提案のステータスを更新
   */
  async updateStatus(
    id: string,
    status: ImprovementStatus,
    result?: { success: boolean; message?: string; commitHash?: string },
    cycleId?: string
  ): Promise<boolean> {
    await this.load();

    const improvement = this.queue.find((i) => i.id === id);
    if (!improvement) return false;

    improvement.status = status;
    improvement.updatedAt = new Date().toISOString();

    if (status === "completed" || status === "failed") {
      improvement.completedAt = new Date().toISOString();
    }

    if (result) {
      improvement.result = result;
    }

    if (cycleId) {
      improvement.cycleId = cycleId;
    }

    await this.save();
    return true;
  }

  /**
   * 改善提案を取得
   */
  async get(id: string): Promise<QueuedImprovement | null> {
    await this.load();
    return this.queue.find((i) => i.id === id) || null;
  }

  /**
   * フィルタ条件で検索
   */
  async find(filter: QueueFilter): Promise<QueuedImprovement[]> {
    await this.load();

    return this.queue.filter((i) => {
      if (filter.status && i.status !== filter.status) return false;
      if (filter.source && i.source !== filter.source) return false;
      if (filter.type && i.type !== filter.type) return false;
      if (filter.minPriority !== undefined && i.priority < filter.minPriority)
        return false;
      if (filter.maxPriority !== undefined && i.priority > filter.maxPriority)
        return false;
      if (filter.relatedPatternId && i.relatedPatternId !== filter.relatedPatternId)
        return false;
      if (filter.since && i.createdAt < filter.since) return false;
      if (filter.until && i.createdAt > filter.until) return false;
      return true;
    });
  }

  /**
   * 保留中の改善提案を優先度順で取得
   */
  async getPending(limit?: number): Promise<QueuedImprovement[]> {
    await this.load();

    const pending = this.queue
      .filter((i) => i.status === "pending")
      .sort((a, b) => b.priority - a.priority);

    return limit ? pending.slice(0, limit) : pending;
  }

  /**
   * 重複チェック（同じタイトルと説明の提案があるか）
   */
  async isDuplicate(title: string, description: string): Promise<boolean> {
    await this.load();

    return this.queue.some(
      (i) =>
        i.status === "pending" &&
        i.title.toLowerCase() === title.toLowerCase() &&
        i.description.toLowerCase() === description.toLowerCase()
    );
  }

  /**
   * 優先度を更新
   */
  async updatePriority(id: string, priority: number): Promise<boolean> {
    await this.load();

    const improvement = this.queue.find((i) => i.id === id);
    if (!improvement) return false;

    improvement.priority = Math.max(0, Math.min(100, priority));
    improvement.updatedAt = new Date().toISOString();
    await this.save();
    return true;
  }

  /**
   * 古い完了済み項目をクリーンアップ
   */
  async cleanup(daysOld: number = 30): Promise<number> {
    await this.load();

    const cutoff = new Date();
    cutoff.setDate(cutoff.getDate() - daysOld);
    const cutoffStr = cutoff.toISOString();

    const before = this.queue.length;
    this.queue = this.queue.filter(
      (i) =>
        i.status === "pending" ||
        i.status === "scheduled" ||
        i.status === "in_progress" ||
        (i.completedAt && i.completedAt >= cutoffStr)
    );

    const removed = before - this.queue.length;
    if (removed > 0) {
      await this.save();
      logger.info("Cleaned up old improvements", { removed });
    }

    return removed;
  }

  /**
   * 統計情報を取得
   */
  async getStats(): Promise<QueueStats> {
    await this.load();

    const statuses: ImprovementStatus[] = [
      "pending",
      "scheduled",
      "in_progress",
      "completed",
      "failed",
      "skipped",
    ];

    const byStatus = Object.fromEntries(
      statuses.map((s) => [s, 0])
    ) as Record<ImprovementStatus, number>;

    const bySource: Record<string, number> = {};
    const byType: Record<string, number> = {};
    let totalPriority = 0;

    for (const imp of this.queue) {
      byStatus[imp.status]++;
      bySource[imp.source] = (bySource[imp.source] || 0) + 1;
      byType[imp.type] = (byType[imp.type] || 0) + 1;
      totalPriority += imp.priority;
    }

    return {
      total: this.queue.length,
      byStatus,
      bySource,
      byType,
      avgPriority: this.queue.length > 0 ? totalPriority / this.queue.length : 0,
    };
  }

  /**
   * 全てのキューを取得
   */
  async getAll(): Promise<QueuedImprovement[]> {
    await this.load();
    return [...this.queue];
  }
}

export const improvementQueue = new ImprovementQueue();
