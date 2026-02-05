import { snapshotManager, SnapshotInfo } from "./snapshot.js";
import { logger } from "../core/logger.js";
import { eventBus } from "../core/event-bus.js";

export interface RollbackResult {
  success: boolean;
  snapshotId: string;
  reason: string;
  timestamp: Date;
}

export class RollbackManager {
  private history: RollbackResult[] = [];
  private maxHistory: number = 50;

  async rollback(snapshotId: string, reason: string): Promise<RollbackResult> {
    logger.warn("Initiating rollback", { snapshotId, reason });

    const success = snapshotManager.restore(snapshotId);
    const result: RollbackResult = {
      success,
      snapshotId,
      reason,
      timestamp: new Date(),
    };

    this.history.push(result);
    if (this.history.length > this.maxHistory) {
      this.history = this.history.slice(-this.maxHistory);
    }

    if (success) {
      logger.info("Rollback successful", { snapshotId });
      await eventBus.emit({
        type: "rollback",
        reason,
        snapshotId,
      });
    } else {
      logger.error("Rollback failed", { snapshotId });
    }

    return result;
  }

  async rollbackToLatest(reason: string): Promise<RollbackResult | null> {
    const snapshots = snapshotManager.list();
    if (snapshots.length === 0) {
      logger.error("No snapshots available for rollback");
      return null;
    }

    return this.rollback(snapshots[0].id, reason);
  }

  getHistory(): RollbackResult[] {
    return [...this.history];
  }

  getLatestSnapshots(count: number = 5): SnapshotInfo[] {
    return snapshotManager.list().slice(0, count);
  }
}

export const rollbackManager = new RollbackManager();
