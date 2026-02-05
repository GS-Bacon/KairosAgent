import { existsSync, readFileSync, writeFileSync } from "fs";
import { Goal, GoalProgress, GoalData, GoalType, GoalMetric } from "./types.js";
import { logger } from "../core/logger.js";

const GOALS_FILE = "./workspace/goals.json";

export class GoalManager {
  private data: GoalData;

  constructor() {
    this.data = this.load();
  }

  private load(): GoalData {
    logger.debug("Loading goals from file", { path: GOALS_FILE, exists: existsSync(GOALS_FILE) });
    if (existsSync(GOALS_FILE)) {
      try {
        const content = readFileSync(GOALS_FILE, "utf-8");
        const data = JSON.parse(content);
        logger.debug("Goals loaded", { goalsCount: data.goals?.length || 0 });
        return data;
      } catch (err) {
        logger.error("Failed to load goals", { error: String(err) });
      }
    }
    logger.debug("No goals file found, returning empty data");
    return { goals: [], progress: [] };
  }

  private save(): void {
    writeFileSync(GOALS_FILE, JSON.stringify(this.data, null, 2));
  }

  createGoal(params: {
    type: GoalType;
    title: string;
    description: string;
    metrics: GoalMetric[];
  }): Goal {
    const goal: Goal = {
      id: `goal_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`,
      type: params.type,
      title: params.title,
      description: params.description,
      metrics: params.metrics,
      createdAt: new Date().toISOString(),
      active: true,
    };

    this.data.goals.push(goal);
    this.save();
    logger.info("Goal created", { goalId: goal.id, title: goal.title });

    return goal;
  }

  getGoal(id: string): Goal | undefined {
    return this.data.goals.find((g) => g.id === id);
  }

  getActiveGoals(): Goal[] {
    return this.data.goals.filter((g) => g.active);
  }

  getAllGoals(): Goal[] {
    return [...this.data.goals];
  }

  updateGoalMetric(goalId: string, metricName: string, newValue: number): void {
    const goal = this.getGoal(goalId);
    if (!goal) {
      logger.warn("Goal not found", { goalId });
      return;
    }

    const metric = goal.metrics.find((m) => m.name === metricName);
    if (!metric) {
      logger.warn("Metric not found", { goalId, metricName });
      return;
    }

    metric.current = newValue;
    this.save();

    logger.debug("Goal metric updated", { goalId, metricName, newValue });
  }

  recordProgress(
    goalId: string,
    cycleId: string,
    metricUpdates: Array<{ name: string; previousValue: number; newValue: number }>,
    notes?: string
  ): void {
    const progress: GoalProgress = {
      goalId,
      cycleId,
      timestamp: new Date().toISOString(),
      metricUpdates,
      notes,
    };

    this.data.progress.push(progress);

    // Also update the goal metrics
    for (const update of metricUpdates) {
      this.updateGoalMetric(goalId, update.name, update.newValue);
    }

    // Check if one-time goal is completed
    const goal = this.getGoal(goalId);
    if (goal && goal.type === "one-time") {
      const allMetricsMet = goal.metrics.every((m) => m.current >= m.target);
      if (allMetricsMet) {
        goal.active = false;
        goal.completedAt = new Date().toISOString();
        logger.info("One-time goal completed", { goalId, title: goal.title });
      }
    }

    this.save();
    logger.info("Goal progress recorded", { goalId, cycleId });
  }

  getProgressHistory(goalId: string): GoalProgress[] {
    return this.data.progress.filter((p) => p.goalId === goalId);
  }

  deactivateGoal(goalId: string): void {
    const goal = this.getGoal(goalId);
    if (goal) {
      goal.active = false;
      this.save();
      logger.info("Goal deactivated", { goalId });
    }
  }

  reactivateGoal(goalId: string): void {
    const goal = this.getGoal(goalId);
    if (goal) {
      goal.active = true;
      goal.completedAt = undefined;
      this.save();
      logger.info("Goal reactivated", { goalId });
    }
  }

  initializeDefaultGoals(): void {
    // トークン最適化目標
    const existingTokenGoal = this.data.goals.find(
      (g) => g.title === "品質維持しながらトークン使用量を最適化"
    );

    if (!existingTokenGoal) {
      this.createGoal({
        type: "permanent",
        title: "品質維持しながらトークン使用量を最適化",
        description: `AI呼び出し時のコンテキストを最適化し、品質を維持・向上しながらトークン消費を削減する。

【制約条件】
- ビルド成功率100%を維持
- テスト成功率を低下させない
- AI修正の品質（正確性）を維持

【最適化手法】
- existingCodeの全文送信を避け、エラー周辺行のみ抽出
- import/export文は常に保持（依存関係情報を失わない）
- 100行未満の小ファイルは最適化しない（品質優先）

【検出対象パターン】
- buildPrompt, createPrompt等でexistingCodeを全文送信している箇所
- 大きなコンテキスト構築（500行以上）
- 重複情報の送信`,
        metrics: [
          { name: "avgTokensPerCycle", target: 5000, current: 10000, unit: "tokens" },
          { name: "buildSuccessRate", target: 100, current: 100, unit: "%" },
          { name: "testSuccessRate", target: 95, current: 95, unit: "%" },
          { name: "optimizationCoverage", target: 80, current: 0, unit: "%" },
        ],
      });
      logger.info("Token optimization goal initialized");
    }

    // 古い形式の目標があれば非アクティブ化
    const oldTokenGoal = this.data.goals.find(
      (g) => g.title === "ClaudeCodeトークン使用量削減"
    );
    if (oldTokenGoal && oldTokenGoal.active) {
      oldTokenGoal.active = false;
      this.save();
      logger.info("Deactivated old token goal in favor of new one");
    }
  }
}

export const goalManager = new GoalManager();
