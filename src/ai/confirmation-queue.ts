/**
 * Claude確認キュー
 *
 * GLMフォールバックで行われた変更を記録し、
 * Claude復活時にレビューするためのキュー
 */

import { existsSync, readFileSync, writeFileSync, mkdirSync } from "fs";
import { dirname } from "path";
import { randomUUID } from "crypto";
import { logger } from "../core/logger.js";

export interface ConfirmationItem {
  id: string;
  changeId: string;  // TrackedChange参照
  status: "pending" | "in_review" | "confirmed" | "rejected" | "needs_review";
  priority: number;
  createdAt: string;
  reviewedAt?: string;
  reviewNotes?: string;
}

export class ConfirmationQueue {
  private items: ConfirmationItem[] = [];
  private storagePath: string;
  private loaded: boolean = false;

  constructor(storagePath: string = "./workspace/confirmation-queue.json") {
    this.storagePath = storagePath;
  }

  /**
   * 永続化データをロード
   */
  private load(): void {
    if (this.loaded) {
      return;
    }

    try {
      if (existsSync(this.storagePath)) {
        const content = readFileSync(this.storagePath, "utf-8");
        const data = JSON.parse(content);
        this.items = Array.isArray(data) ? data : [];
      }
    } catch (err) {
      logger.warn("Failed to load confirmation queue", {
        error: err instanceof Error ? err.message : String(err),
      });
      this.items = [];
    }

    this.loaded = true;
  }

  /**
   * 永続化データを保存
   */
  private save(): void {
    try {
      const dir = dirname(this.storagePath);
      if (!existsSync(dir)) {
        mkdirSync(dir, { recursive: true });
      }

      writeFileSync(this.storagePath, JSON.stringify(this.items, null, 2));
    } catch (err) {
      logger.error("Failed to save confirmation queue", {
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }

  /**
   * 変更から確認アイテムを追加
   */
  async addFromChange(changeId: string, priority: number): Promise<string> {
    this.load();

    // 既に同じchangeIdが登録されていないかチェック
    const existing = this.items.find((i) => i.changeId === changeId);
    if (existing) {
      logger.debug("Change already in confirmation queue", { changeId });
      return existing.id;
    }

    const item: ConfirmationItem = {
      id: randomUUID(),
      changeId,
      status: "pending",
      priority,
      createdAt: new Date().toISOString(),
    };

    this.items.push(item);
    this.save();

    logger.info("Added to confirmation queue", {
      id: item.id,
      changeId,
      priority,
    });

    return item.id;
  }

  /**
   * 保留中のアイテムを取得（優先度順）
   */
  async getPending(): Promise<ConfirmationItem[]> {
    this.load();
    return this.items
      .filter((i) => i.status === "pending")
      .sort((a, b) => b.priority - a.priority);
  }

  /**
   * レビュー中としてマーク
   */
  async markInReview(id: string): Promise<void> {
    this.load();
    const item = this.items.find((i) => i.id === id);
    if (item) {
      item.status = "in_review";
      this.save();
    }
  }

  /**
   * レビュー済みとしてマーク
   */
  async markReviewed(
    id: string,
    status: "confirmed" | "rejected" | "needs_review",
    notes?: string
  ): Promise<void> {
    this.load();
    const item = this.items.find((i) => i.id === id);
    if (item) {
      item.status = status;
      item.reviewedAt = new Date().toISOString();
      item.reviewNotes = notes;
      this.save();

      logger.info("Confirmation item reviewed", {
        id,
        status,
        notes: notes?.slice(0, 100),
      });
    }
  }

  /**
   * IDでアイテムを取得
   */
  async getById(id: string): Promise<ConfirmationItem | undefined> {
    this.load();
    return this.items.find((i) => i.id === id);
  }

  /**
   * changeIdでアイテムを取得
   */
  async getByChangeId(changeId: string): Promise<ConfirmationItem | undefined> {
    this.load();
    return this.items.find((i) => i.changeId === changeId);
  }

  /**
   * 全アイテムを取得
   */
  async getAll(): Promise<ConfirmationItem[]> {
    this.load();
    return [...this.items];
  }

  /**
   * 統計を取得
   */
  async getStats(): Promise<{
    total: number;
    pending: number;
    inReview: number;
    confirmed: number;
    rejected: number;
    needsReview: number;
  }> {
    this.load();

    const stats = {
      total: this.items.length,
      pending: 0,
      inReview: 0,
      confirmed: 0,
      rejected: 0,
      needsReview: 0,
    };

    for (const item of this.items) {
      switch (item.status) {
        case "pending":
          stats.pending++;
          break;
        case "in_review":
          stats.inReview++;
          break;
        case "confirmed":
          stats.confirmed++;
          break;
        case "rejected":
          stats.rejected++;
          break;
        case "needs_review":
          stats.needsReview++;
          break;
      }
    }

    return stats;
  }

  /**
   * 古いアイテムをクリーンアップ（30日以上前の確認済み）
   */
  async cleanup(maxAgeDays: number = 30): Promise<number> {
    this.load();

    const cutoff = new Date();
    cutoff.setDate(cutoff.getDate() - maxAgeDays);
    const cutoffTime = cutoff.getTime();

    const before = this.items.length;
    this.items = this.items.filter((i) => {
      // pending/in_review/needs_reviewは保持
      if (i.status === "pending" || i.status === "in_review" || i.status === "needs_review") {
        return true;
      }
      // confirmed/rejectedは期限切れなら削除
      if (i.reviewedAt) {
        const reviewedTime = new Date(i.reviewedAt).getTime();
        return reviewedTime > cutoffTime;
      }
      return true;
    });

    const removed = before - this.items.length;
    if (removed > 0) {
      this.save();
      logger.info("Cleaned up old confirmation items", { removed });
    }

    return removed;
  }
}

// シングルトンインスタンス
export const confirmationQueue = new ConfirmationQueue();
