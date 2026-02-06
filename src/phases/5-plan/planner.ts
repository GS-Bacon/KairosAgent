import { Issue, Improvement, SearchResult } from "../types.js";
import { Plan, PlanStep } from "./types.js";
import { getAIProvider } from "../../ai/factory.js";
import { logger } from "../../core/logger.js";
import { parseJSONArray } from "../../ai/json-parser.js";

export class RepairPlanner {
  async createPlan(
    target: Issue | Improvement,
    searchResults?: SearchResult
  ): Promise<Plan> {
    const isIssue = "type" in target && ["error", "warning", "critical"].includes(target.type);
    const description = isIssue
      ? (target as Issue).message
      : (target as Improvement).description;

    logger.debug("Creating repair plan", { target: description });

    // Try to use AI for planning
    let steps: PlanStep[] = [];
    try {
      const ai = getAIProvider();
      const prompt = this.buildPlanPrompt(target, searchResults);
      const response = await ai.chat(prompt);
      steps = this.parsePlanFromAI(response);
    } catch (err) {
      logger.warn("AI planning failed, using fallback");
      steps = this.createFallbackPlan(target);
    }

    const affectedFiles = [...new Set(steps.map((s) => s.file))];
    const risk = this.assessRisk(steps, affectedFiles);

    return {
      id: `plan_${Date.now()}`,
      targetType: isIssue ? "issue" : "improvement",
      targetId: target.id,
      description: `Fix: ${description}`,
      steps,
      affectedFiles,
      risk,
      requiresTest: steps.some((s) => s.action !== "delete"),
    };
  }

  private buildPlanPrompt(target: Issue | Improvement, searchResults?: SearchResult): string {
    const isIssue = "message" in target;
    const desc = isIssue ? (target as Issue).message : (target as Improvement).description;
    const file = target.file || "unknown";

    let context = "";
    if (searchResults?.findings) {
      context = searchResults.findings
        .slice(0, 5)
        .map((f) => `${f.file}: ${f.content}`)
        .join("\n");
    }

    return `Create a repair plan for this ${isIssue ? "error" : "improvement"}:

Problem: ${desc}
File: ${file}

Related code:
${context || "No related code found"}

Output a JSON array of steps:
[
  {"order": 1, "action": "modify|create|delete|refactor", "file": "path", "details": "what to do"}
]

Be specific and minimal. Output ONLY the JSON array.`;
  }

  private parsePlanFromAI(response: string): PlanStep[] {
    const parsed = parseJSONArray<Array<{
      order?: number;
      action?: string;
      file?: string;
      details?: string;
    }>>(response);

    if (parsed && Array.isArray(parsed)) {
      return parsed.map((step, i: number) => ({
        order: step.order || i + 1,
        action: this.normalizeAction(step.action),
        file: step.file || "unknown",
        details: step.details || "",
      }));
    }

    logger.warn("Failed to parse AI plan response");
    return [];
  }

  private normalizeAction(action?: string): "create" | "modify" | "delete" | "refactor" {
    const validActions = ["create", "modify", "delete", "refactor"] as const;
    if (action && validActions.includes(action as typeof validActions[number])) {
      return action as "create" | "modify" | "delete" | "refactor";
    }
    return "modify";
  }

  private createFallbackPlan(target: Issue | Improvement): PlanStep[] {
    const file = target.file || "src/index.ts";

    return [
      {
        order: 1,
        action: "modify",
        file,
        details: `Review and fix: ${"message" in target ? target.message : (target as Improvement).description}`,
      },
    ];
  }

  private assessRisk(steps: PlanStep[], affectedFiles: string[]): "low" | "medium" | "high" {
    if (affectedFiles.length > 3) return "high";
    if (steps.some((s) => s.action === "delete")) return "medium";
    if (steps.some((s) => s.action === "create")) return "low";
    if (steps.length > 5) return "medium";
    return "low";
  }
}
