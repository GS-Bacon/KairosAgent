import { Phase, PhaseResult, CycleContext } from "../types.js";
import { CodeImplementer } from "./implementer.js";
import { snapshotManager } from "../../safety/snapshot.js";
import { logger } from "../../core/logger.js";

export class ImplementPhase implements Phase {
  name = "implement";
  private implementer: CodeImplementer;

  constructor() {
    this.implementer = new CodeImplementer();
  }

  async execute(context: CycleContext): Promise<PhaseResult> {
    if (!context.plan) {
      return {
        success: false,
        shouldStop: true,
        message: "No plan to implement",
      };
    }

    logger.debug("Implementing repair plan", { planId: context.plan.id });

    const result = await this.implementer.implement(context.plan);

    context.snapshotId = result.snapshotId;
    context.implementedChanges = result.changes.map((c) => ({
      file: c.file,
      changeType: c.changeType,
    }));

    if (!result.success) {
      const failed = result.changes.filter((c) => !c.success);
      logger.error("Implementation failed", {
        failedChanges: failed.map((c) => ({ file: c.file, error: c.error })),
      });

      // スナップショットからロールバック
      if (result.snapshotId) {
        try {
          snapshotManager.restore(result.snapshotId);
          logger.info("Rolled back to snapshot after implementation failure", {
            snapshotId: result.snapshotId,
          });
        } catch (err) {
          logger.error("Failed to restore snapshot", {
            error: err instanceof Error ? err.message : String(err),
          });
        }
      }

      return {
        success: false,
        shouldStop: true,
        message: `Implementation failed: ${failed.length} changes failed (rolled back)`,
        data: result,
      };
    }

    logger.info("Implementation completed", {
      planId: result.planId,
      changesCount: result.changes.length,
    });

    return {
      success: true,
      shouldStop: false,
      message: `Implemented ${result.changes.length} changes`,
      data: result,
    };
  }
}

export { CodeImplementer } from "./implementer.js";
export * from "./types.js";
