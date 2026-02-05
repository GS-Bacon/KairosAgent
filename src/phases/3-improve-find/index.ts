import { Phase, PhaseResult, CycleContext, Improvement } from "../types.js";
import { ImprovementFinder } from "./finder.js";
import { logger } from "../../core/logger.js";
import { toolTracker } from "../../tools/index.js";

export class ImproveFindPhase implements Phase {
  name = "improve-find";
  private finder: ImprovementFinder;

  constructor() {
    this.finder = new ImprovementFinder();
  }

  async execute(context: CycleContext): Promise<PhaseResult> {
    logger.debug("Finding improvement opportunities");

    const result = await this.finder.find();

    for (const marker of result.markers) {
      const priority = this.markerPriority(marker.type);
      if (priority !== "low") {
        context.improvements.push({
          id: `imp_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`,
          type: marker.type === "fixme" ? "fixme" : "todo",
          description: marker.text,
          file: marker.file,
          line: marker.line,
          priority,
        });
      }
    }

    for (const issue of result.qualityIssues) {
      if (issue.severity !== "low") {
        context.improvements.push({
          id: `qual_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`,
          type: issue.type === "complexity" ? "refactor" : "optimization",
          description: issue.description,
          file: issue.file,
          priority: issue.severity,
        });
      }
    }

    // Add tool recommendations as improvements
    const toolSuggestions = toolTracker.suggestTools();
    for (const suggestion of toolSuggestions) {
      context.improvements.push({
        id: `tool_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`,
        type: "tool-adoption",
        description: `Adopt ${suggestion.toolName}: ${suggestion.reason}${
          suggestion.installCommand ? ` (${suggestion.installCommand})` : ""
        }`,
        file: "package.json",
        priority: suggestion.priority,
      });
    }

    const totalIssues = context.issues.length;
    const totalImprovements = context.improvements.length;

    if (totalIssues === 0 && totalImprovements === 0) {
      logger.info("No issues or improvements found");
      return {
        success: true,
        shouldStop: true,
        message: "No work needed - system is healthy",
      };
    }

    logger.info("Found improvement opportunities", {
      markers: result.markers.length,
      qualityIssues: result.qualityIssues.length,
      totalImprovements,
    });

    return {
      success: true,
      shouldStop: false,
      message: `Found ${totalIssues} issues, ${totalImprovements} improvements`,
      data: result,
    };
  }

  private markerPriority(type: string): "low" | "medium" | "high" {
    switch (type) {
      case "fixme":
        return "high";
      case "todo":
      case "hack":
        return "medium";
      default:
        return "low";
    }
  }
}

export { ImprovementFinder } from "./finder.js";
export * from "./types.js";
