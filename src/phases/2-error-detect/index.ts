import { Phase, PhaseResult, CycleContext, Issue } from "../types.js";
import { ErrorDetector } from "./detector.js";
import { logger } from "../../core/logger.js";
import { eventBus } from "../../core/event-bus.js";

export class ErrorDetectPhase implements Phase {
  name = "error-detect";
  private detector: ErrorDetector;

  constructor() {
    this.detector = new ErrorDetector();
  }

  async execute(context: CycleContext): Promise<PhaseResult> {
    logger.debug("Detecting errors");

    const logResult = await this.detector.detect();
    const buildErrors = await this.detector.detectBuildErrors();

    for (const error of logResult.errors) {
      const issue: Issue = {
        id: `err_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`,
        type: "error",
        source: error.source,
        message: error.message,
        timestamp: error.timestamp,
      };
      context.issues.push(issue);

      await eventBus.emit({
        type: "issue_detected",
        issue: { type: issue.type, description: issue.message },
      });
    }

    for (const error of buildErrors) {
      const issue: Issue = {
        id: `build_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`,
        type: "error",
        source: "typescript",
        message: error.message,
        timestamp: error.timestamp,
      };
      context.issues.push(issue);

      await eventBus.emit({
        type: "issue_detected",
        issue: { type: issue.type, description: issue.message },
      });
    }

    const totalErrors = logResult.errors.length + buildErrors.length;
    logger.info("Error detection complete", {
      logErrors: logResult.errors.length,
      buildErrors: buildErrors.length,
      warnings: logResult.warnings.length,
    });

    return {
      success: true,
      shouldStop: false,
      message: `Found ${totalErrors} errors, ${logResult.warnings.length} warnings`,
      data: { logResult, buildErrors },
    };
  }
}

export { ErrorDetector } from "./detector.js";
export * from "./types.js";
