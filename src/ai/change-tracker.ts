/**
 * GLM変更追跡システム
 *
 * GLMによる変更を記録し、Claude復活時のレビューに備える
 */

import { existsSync, readFileSync } from "fs";
import { randomUUID } from "crypto";
import { logger } from "../core/logger.js";
import { atomicWriteFileSync } from "../utils/atomic-write.js";
import { safeJsonParse } from "../utils/safe-json.js";
import { TrackedChangesArraySchema } from "../utils/schemas.js";

export interface ReviewResult {
  approved: boolean;
  issues: string[];
  suggestions: string[];
}

export interface TrackedChange {
  id: string;
  timestamp: string;
  phase: string;
  provider: "glm";
  files: string[];
  description: string;
  reviewed: boolean;
  reviewResult?: ReviewResult;
  confirmationStatus?: "pending" | "confirmed" | "rejected" | "needs_review";
}

export class ChangeTracker {
  private changes: TrackedChange[] = [];
  private storagePath: string;
  private loaded: boolean = false;

  constructor(storagePath: string = "./workspace/glm-changes.json") {
    this.storagePath = storagePath;
  }

  /**
   * 永続化データをロード（同期版、ミューテックス付き）
   */
  private load(): void {
    if (this.loaded) {
      return;
    }

    try {
      if (existsSync(this.storagePath)) {
        const content = readFileSync(this.storagePath, "utf-8");
        const data = safeJsonParse(content, TrackedChangesArraySchema, "glm-changes.json");
        this.changes = data || [];
      }
    } catch (err) {
      logger.warn("Failed to load GLM changes", {
        error: err instanceof Error ? err.message : String(err),
      });
      this.changes = [];
    }

    this.loaded = true;
  }

  /**
   * 永続化データを保存
   */
  private save(): void {
    try {
      atomicWriteFileSync(this.storagePath, JSON.stringify(this.changes, null, 2));
    } catch (err) {
      logger.error("Failed to save GLM changes", {
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }

  /**
   * 変更を記録
   */
  recordChange(change: Omit<TrackedChange, "id" | "reviewed">): string {
    this.load();

    const tracked: TrackedChange = {
      ...change,
      id: randomUUID(),
      reviewed: false,
    };

    this.changes.push(tracked);
    this.save();

    logger.info("GLM change recorded", {
      id: tracked.id,
      phase: tracked.phase,
      filesCount: tracked.files.length,
    });

    return tracked.id;
  }

  /**
   * 未レビューの変更を取得
   */
  getUnreviewedChanges(): TrackedChange[] {
    this.load();
    return this.changes.filter((c) => !c.reviewed);
  }

  /**
   * レビュー済みとしてマーク
   */
  markReviewed(id: string, result: ReviewResult): void {
    this.load();

    const change = this.changes.find((c) => c.id === id);
    if (change) {
      change.reviewed = true;
      change.reviewResult = result;
      this.save();

      logger.info("GLM change reviewed", {
        id,
        approved: result.approved,
        issueCount: result.issues.length,
      });
    }
  }

  /**
   * IDで変更を取得
   */
  getChange(id: string): TrackedChange | undefined {
    this.load();
    return this.changes.find((c) => c.id === id);
  }

  /**
   * 全変更を取得
   */
  getAllChanges(): TrackedChange[] {
    this.load();
    return [...this.changes];
  }

  /**
   * 古い変更をクリーンアップ（30日以上前のレビュー済み）
   */
  cleanup(maxAgeDays: number = 30): number {
    this.load();

    const cutoff = new Date();
    cutoff.setDate(cutoff.getDate() - maxAgeDays);
    const cutoffTime = cutoff.getTime();

    const before = this.changes.length;
    this.changes = this.changes.filter((c) => {
      if (!c.reviewed) {
        return true; // 未レビューは保持
      }
      const changeTime = new Date(c.timestamp).getTime();
      return changeTime > cutoffTime;
    });

    const removed = before - this.changes.length;
    if (removed > 0) {
      this.save();
      logger.info("Cleaned up old GLM changes", { removed });
    }

    return removed;
  }

  /**
   * 統計を取得
   */
  getStats(): {
    total: number;
    unreviewed: number;
    approved: number;
    rejected: number;
    byPhase: Record<string, number>;
  } {
    this.load();

    const stats = {
      total: this.changes.length,
      unreviewed: 0,
      approved: 0,
      rejected: 0,
      byPhase: {} as Record<string, number>,
    };

    for (const change of this.changes) {
      // フェーズごとのカウント
      stats.byPhase[change.phase] = (stats.byPhase[change.phase] || 0) + 1;

      if (!change.reviewed) {
        stats.unreviewed++;
      } else if (change.reviewResult?.approved) {
        stats.approved++;
      } else {
        stats.rejected++;
      }
    }

    return stats;
  }
}

// シングルトンインスタンス
export const changeTracker = new ChangeTracker();
