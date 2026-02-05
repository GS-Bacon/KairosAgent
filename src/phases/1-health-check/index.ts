import { Phase, PhaseResult, CycleContext } from "../types.js";
import { HealthChecker } from "./checker.js";
import { logger } from "../../core/logger.js";

export class HealthCheckPhase implements Phase {
  name = "health-check";
  private checker: HealthChecker;

  constructor() {
    this.checker = new HealthChecker();
  }

  async execute(context: CycleContext): Promise<PhaseResult> {
    logger.debug("Running health checks");

    const status = await this.checker.run();

    if (status.overall === "unhealthy") {
      const failedChecks = status.checks
        .filter((c) => c.status === "fail")
        .map((c) => c.name);

      return {
        success: false,
        shouldStop: true,
        message: `System unhealthy: ${failedChecks.join(", ")}`,
        data: status,
      };
    }

    if (status.overall === "degraded") {
      logger.warn("System degraded but continuing", {
        warnings: status.checks.filter((c) => c.status === "warn"),
      });
    }

    return {
      success: true,
      shouldStop: false,
      message: `Health: ${status.overall}`,
      data: status,
    };
  }
}

export { HealthChecker } from "./checker.js";
export * from "./types.js";
