/**
 * Work Detector
 *
 * 軽量チェックで「やることがあるか」を高速判定
 * サイクル実行前に呼び出し、作業がなければ早期終了
 */

import { exec } from "child_process";
import { promisify } from "util";
import { improvementQueue } from "../improvement-queue/index.js";
import { goalManager } from "../goals/index.js";
import { logger } from "./logger.js";

const execAsync = promisify(exec);

export interface WorkDetectionResult {
  hasWork: boolean;
  hasBuildErrors: boolean;
  hasPendingImprovements: boolean;
  hasActiveGoals: boolean;
  pendingImprovementCount: number;
  activeGoalCount: number;
  checkDuration: number;
}

class WorkDetector {
  /**
   * ビルドエラーの有無をチェック（軽量）
   */
  private async checkBuildErrors(): Promise<boolean> {
    try {
      await execAsync("npm run build --dry-run 2>&1", { timeout: 30000 });
      return false;
    } catch {
      // dry-runがない場合は簡易チェック：TypeScriptコンパイルチェック
      try {
        await execAsync("npx tsc --noEmit 2>&1", { timeout: 60000 });
        return false;
      } catch {
        return true;
      }
    }
  }

  /**
   * 改善キューに未処理項目があるかチェック
   */
  private async checkPendingImprovements(): Promise<{ hasPending: boolean; count: number }> {
    try {
      const pending = await improvementQueue.getPending();
      return { hasPending: pending.length > 0, count: pending.length };
    } catch {
      return { hasPending: false, count: 0 };
    }
  }

  /**
   * アクティブ目標の残作業があるかチェック
   */
  private checkActiveGoals(): { hasActive: boolean; count: number } {
    try {
      const activeGoals = goalManager.getActiveGoals();
      // 目標のメトリクスが未達成のものがあるかチェック
      const goalsWithRemainingWork = activeGoals.filter((goal) =>
        goal.metrics.some((m) => m.current < m.target)
      );
      return {
        hasActive: goalsWithRemainingWork.length > 0,
        count: goalsWithRemainingWork.length,
      };
    } catch {
      return { hasActive: false, count: 0 };
    }
  }

  /**
   * 作業があるかどうかを総合判定
   */
  async hasWork(): Promise<boolean> {
    const result = await this.detect();
    return result.hasWork;
  }

  /**
   * 作業検出の詳細結果を取得
   */
  async detect(): Promise<WorkDetectionResult> {
    const startTime = Date.now();

    // 並列でチェック実行
    const [buildErrorsResult, improvementResult, goalsResult] = await Promise.all([
      this.checkBuildErrors().catch(() => false),
      this.checkPendingImprovements().catch(() => ({ hasPending: false, count: 0 })),
      Promise.resolve(this.checkActiveGoals()),
    ]);

    const hasBuildErrors = buildErrorsResult;
    const hasPendingImprovements = improvementResult.hasPending;
    const hasActiveGoals = goalsResult.hasActive;

    const hasWork = hasBuildErrors || hasPendingImprovements || hasActiveGoals;
    const checkDuration = Date.now() - startTime;

    const result: WorkDetectionResult = {
      hasWork,
      hasBuildErrors,
      hasPendingImprovements,
      hasActiveGoals,
      pendingImprovementCount: improvementResult.count,
      activeGoalCount: goalsResult.count,
      checkDuration,
    };

    logger.debug("Work detection completed", {
      hasWork: result.hasWork,
      hasBuildErrors: result.hasBuildErrors,
      hasPendingImprovements: result.hasPendingImprovements,
      hasActiveGoals: result.hasActiveGoals,
      pendingImprovementCount: result.pendingImprovementCount,
      activeGoalCount: result.activeGoalCount,
      checkDuration: result.checkDuration,
    });

    return result;
  }
}

export const workDetector = new WorkDetector();
