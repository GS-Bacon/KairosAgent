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
    if (existsSync(GOALS_FILE)) {
      try {
        const content = readFileSync(GOALS_FILE, "utf-8");
        return JSON.parse(content);
      } catch (err) {
        logger.error("Failed to load goals", { error: String(err) });
      }
    }
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
    const existingTokenGoal = this.data.goals.find(
      (g) => g.title === "ClaudeCodeトークン使用量削減"
    );

    if (!existingTokenGoal) {
      this.createGoal({
        type: "permanent",
        title: "ClaudeCodeトークン使用量削減",
        description:
          "GLM4を下働きとして活用し、Claudeの使用を重要な判断に限定",
        metrics: [{ name: "tokensSaved", target: 1000, current: 0 }],
      });
      logger.info("Default permanent goal initialized");
    }
  }
}

export const goalManager = new GoalManager();
