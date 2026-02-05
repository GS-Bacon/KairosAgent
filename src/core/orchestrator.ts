import { logger } from "./logger.js";
import { eventBus } from "./event-bus.js";
import { Phase, CycleContext, createCycleContext } from "../phases/types.js";

import { HealthCheckPhase } from "../phases/1-health-check/index.js";
import { ErrorDetectPhase } from "../phases/2-error-detect/index.js";
import { ImproveFindPhase } from "../phases/3-improve-find/index.js";
import { SearchPhase } from "../phases/4-search/index.js";
import { PlanPhase } from "../phases/5-plan/index.js";
import { ImplementPhase } from "../phases/6-implement/index.js";
import { TestGenPhase } from "../phases/7-test-gen/index.js";
import { VerifyPhase } from "../phases/8-verify/index.js";

export class Orchestrator {
  private phases: Phase[];
  private isRunning: boolean = false;
  private currentContext: CycleContext | null = null;

  constructor() {
    this.phases = [
      new HealthCheckPhase(),
      new ErrorDetectPhase(),
      new ImproveFindPhase(),
      new SearchPhase(),
      new PlanPhase(),
      new ImplementPhase(),
      new TestGenPhase(),
      new VerifyPhase(),
    ];
  }

  async runCycle(): Promise<CycleContext> {
    if (this.isRunning) {
      logger.warn("Cycle already running, skipping");
      throw new Error("Cycle already in progress");
    }

    this.isRunning = true;
    const context = createCycleContext();
    this.currentContext = context;

    logger.info("Starting improvement cycle", { cycleId: context.cycleId });
    await eventBus.emit({ type: "cycle_started", timestamp: context.startTime });

    try {
      for (const phase of this.phases) {
        logger.info(`Executing phase: ${phase.name}`);
        await eventBus.emit({
          type: "phase_started",
          phase: phase.name,
          timestamp: new Date(),
        });

        const result = await phase.execute(context);

        await eventBus.emit({
          type: "phase_completed",
          phase: phase.name,
          success: result.success,
          timestamp: new Date(),
        });

        if (!result.success) {
          logger.warn(`Phase ${phase.name} failed`, { message: result.message });
        }

        if (result.shouldStop) {
          logger.info(`Phase ${phase.name} requested stop`, { message: result.message });
          break;
        }
      }
    } catch (err) {
      const errorMessage = err instanceof Error ? err.message : String(err);
      logger.error("Cycle failed with error", { error: errorMessage });
      await eventBus.emit({
        type: "error",
        error: errorMessage,
        context: { cycleId: context.cycleId },
      });
    } finally {
      this.isRunning = false;
      const duration = Date.now() - context.startTime.getTime();
      await eventBus.emit({
        type: "cycle_completed",
        timestamp: new Date(),
        duration,
      });
      logger.info("Cycle completed", { cycleId: context.cycleId, duration });
    }

    return context;
  }

  getStatus(): {
    isRunning: boolean;
    currentCycleId?: string;
    phases: string[];
  } {
    return {
      isRunning: this.isRunning,
      currentCycleId: this.currentContext?.cycleId,
      phases: this.phases.map((p) => p.name),
    };
  }
}

export const orchestrator = new Orchestrator();
