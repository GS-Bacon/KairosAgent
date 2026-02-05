import { Phase, PhaseResult, CycleContext } from "../types.js";
import { RepairPlanner } from "./planner.js";
import { logger } from "../../core/logger.js";

export class PlanPhase implements Phase {
  name = "plan";
  private planner: RepairPlanner;

  constructor() {
    this.planner = new RepairPlanner();
  }

  async execute(context: CycleContext): Promise<PhaseResult> {
    if (context.issues.length === 0 && context.improvements.length === 0) {
      return {
        success: true,
        shouldStop: true,
        message: "No issues or improvements to plan for",
      };
    }

    logger.debug("Creating repair plan");

    // Prioritize issues over improvements
    const target = context.issues[0] || context.improvements[0];
    const plan = await this.planner.createPlan(target, context.searchResults);

    if (plan.steps.length === 0) {
      logger.warn("Could not create a valid plan");
      return {
        success: false,
        shouldStop: true,
        message: "Failed to create repair plan",
      };
    }

    context.plan = {
      id: plan.id,
      targetIssue: context.issues[0],
      targetImprovement: context.improvements[0],
      description: plan.description,
      steps: plan.steps,
      estimatedRisk: plan.risk,
      affectedFiles: plan.affectedFiles,
    };

    logger.info("Repair plan created", {
      planId: plan.id,
      steps: plan.steps.length,
      risk: plan.risk,
    });

    return {
      success: true,
      shouldStop: false,
      message: `Plan created with ${plan.steps.length} steps (risk: ${plan.risk})`,
      data: plan,
    };
  }
}

export { RepairPlanner } from "./planner.js";
export * from "./types.js";
