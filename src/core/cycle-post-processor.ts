/**
 * Cycle Post Processor
 *
 * サイクル後処理を担当: トラブル抽象化、ドキュメント更新、確認レビュー
 * orchestrator.ts から抽出
 */

import { logger } from "./logger.js";
import { CycleContext } from "../phases/types.js";
import { ClaudeProvider } from "../ai/claude-provider.js";
import { confirmationQueue } from "../ai/confirmation-queue.js";
import { changeTracker } from "../ai/change-tracker.js";
import { claudeReviewer } from "../ai/claude-reviewer.js";
import { abstractionEngine } from "../abstraction/index.js";
import { collectFromAbstraction } from "../improvement-queue/index.js";
import { documentUpdater } from "../docs/index.js";
import { ORCHESTRATION } from "../config/constants.js";

export class CyclePostProcessor {
  /**
   * 全後処理を実行
   */
  async run(context: CycleContext): Promise<void> {
    await this.executeAbstraction(context);
    await this.executeDocumentUpdate();
  }

  /**
   * トラブル抽象化と改善キュー追加
   */
  async executeAbstraction(context: CycleContext): Promise<void> {
    const troubles = context.troubles || [];
    if (troubles.length === 0) {
      logger.debug("No troubles to abstract");
      return;
    }

    try {
      const result = await abstractionEngine.analyze({
        troubles,
        existingPatterns: await abstractionEngine.getPatterns(),
        cycleId: context.cycleId,
      });

      logger.info("Abstraction completed", {
        newPatterns: result.newPatterns.length,
        updatedPatterns: result.updatedPatterns.length,
        preventionSuggestions: result.preventionSuggestions.length,
      });

      if (result.preventionSuggestions.length > 0) {
        const collected = await collectFromAbstraction();
        logger.info("Collected improvements from abstraction", { count: collected });
      }
    } catch (error) {
      logger.warn("Failed to execute abstraction", { error });
    }
  }

  /**
   * ドキュメント自動更新
   */
  async executeDocumentUpdate(): Promise<void> {
    try {
      const results = await documentUpdater.updateAllDocuments();
      const updated = results.filter((r) => r.updated);

      if (updated.length > 0) {
        logger.info("Documents updated", {
          count: updated.length,
          documents: updated.map((r) => r.path),
        });
      }
    } catch (error) {
      logger.warn("Failed to update documents", { error });
    }
  }

  /**
   * GLMフォールバック変更の確認レビュー
   */
  async reviewPendingConfirmations(): Promise<void> {
    try {
      const claude = new ClaudeProvider();
      const isAvailable = await claude.isAvailable();
      if (!isAvailable) {
        logger.debug("Claude not available, skipping confirmation review");
        return;
      }

      const pending = await confirmationQueue.getPending();
      if (pending.length === 0) return;

      logger.info("Reviewing GLM fallback changes from previous cycles", {
        count: pending.length,
      });

      for (const item of pending.slice(0, ORCHESTRATION.MAX_CONFIRMATIONS_PER_CYCLE)) {
        const change = changeTracker.getChange(item.changeId);
        if (!change) {
          await confirmationQueue.markReviewed(item.id, "confirmed", "Change not found");
          continue;
        }

        try {
          await confirmationQueue.markInReview(item.id);
          const result = await claudeReviewer.reviewPendingChanges();

          if (result.issues.length > 0) {
            await confirmationQueue.markReviewed(
              item.id,
              "needs_review",
              result.issues.map((i) => i.issues.join(", ")).join("; ")
            );
          } else {
            await confirmationQueue.markReviewed(item.id, "confirmed", "No issues found");
          }
        } catch (err) {
          logger.warn("Failed to review confirmation item", {
            itemId: item.id,
            error: err instanceof Error ? err.message : String(err),
          });
        }
      }
    } catch (error) {
      logger.warn("Confirmation review failed", {
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }
}

export const cyclePostProcessor = new CyclePostProcessor();
