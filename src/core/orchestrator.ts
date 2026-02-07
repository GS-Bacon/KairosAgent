/**
 * Orchestrator
 *
 * 8フェーズの改善サイクルを統合制御
 * 学習パイプライン、リサーチ、後処理は外部モジュールに委譲
 */

import { logger } from "./logger.js";
import { eventBus } from "./event-bus.js";
import { Phase, CycleContext, CycleResult, CycleQuality, createCycleContext } from "../phases/types.js";
import { goalManager } from "../goals/index.js";
import { getAIProvider } from "../ai/factory.js";
import { HybridProvider, PhaseName } from "../ai/hybrid-provider.js";
import { tokenTracker } from "../ai/token-tracker.js";
import { workDetector } from "./work-detector.js";
import { cycleLogger } from "./cycle-logger.js";
import { cyclePostProcessor } from "./cycle-post-processor.js";
import { confirmationQueue } from "../ai/confirmation-queue.js";
import { changeTracker } from "../ai/change-tracker.js";

import { HealthCheckPhase } from "../phases/1-health-check/index.js";
import { ErrorDetectPhase } from "../phases/2-error-detect/index.js";
import { ImproveFindPhase } from "../phases/3-improve-find/index.js";
import { SearchPhase } from "../phases/4-search/index.js";
import { PlanPhase } from "../phases/5-plan/index.js";
import { ImplementPhase } from "../phases/6-implement/index.js";
import { TestGenPhase } from "../phases/7-test-gen/index.js";
import { VerifyPhase } from "../phases/8-verify/index.js";

import {
  patternRepository,
  initializeLearningSystem,
} from "../learning/index.js";
import { executeFeedbackLoop } from "../learning/learning-pipeline.js";
import { troubleCollector } from "../trouble/index.js";
import { improvementQueue } from "../improvement-queue/index.js";
import {
  shouldRunResearch,
  executeResearch,
  runResearchCycle as runResearchCycleImpl,
} from "../research/research-executor.js";
import { ORCHESTRATION } from "../config/constants.js";

export class Orchestrator {
  private phases: Phase[];
  private isRunning: boolean = false;
  private currentContext: CycleContext | null = null;
  private lastFailedPhase: string | null = null;
  private hasCriticalFailure: boolean = false;
  private consecutiveCycleFailures: number = 0;
  private systemPaused: boolean = false;
  private readonly MAX_CONSECUTIVE_FAILURES = ORCHESTRATION.MAX_CONSECUTIVE_FAILURES;
  private cycleCount: number = 0;

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

  async runCycle(): Promise<CycleResult> {
    if (this.isRunning) {
      logger.warn("Cycle already running, skipping");
      throw new Error("Cycle already in progress");
    }
    this.isRunning = true;

    if (this.systemPaused) {
      this.isRunning = false;
      logger.warn("System is paused due to consecutive failures", {
        consecutiveFailures: this.consecutiveCycleFailures,
      });
      return {
        cycleId: `paused_${Date.now()}`,
        success: false,
        duration: 0,
        troubleCount: 0,
        shouldRetry: false,
        retryReason: "System paused due to consecutive failures",
        failedPhase: undefined,
        skippedEarly: false,
      };
    }

    const workDetectionResult = await workDetector.detect();
    if (!workDetectionResult.hasWork) {
      this.isRunning = false;
      logger.info("No work detected, skipping cycle", {
        checkDuration: workDetectionResult.checkDuration,
      });
      return {
        cycleId: `skipped_${Date.now()}`,
        success: true,
        duration: workDetectionResult.checkDuration,
        troubleCount: 0,
        shouldRetry: false,
        skippedEarly: true,
      };
    }

    logger.info("Work detected, proceeding with cycle", {
      hasBuildErrors: workDetectionResult.hasBuildErrors,
      pendingImprovements: workDetectionResult.pendingImprovementCount,
      activeGoals: workDetectionResult.activeGoalCount,
    });

    this.lastFailedPhase = null;
    this.hasCriticalFailure = false;
    this.cycleCount++;
    const context = createCycleContext();
    this.currentContext = context;

    tokenTracker.startCycle(context.cycleId);

    try {
      await initializeLearningSystem();
    } catch (error) {
      logger.warn("Failed to initialize learning system", { error });
    }

    context.activeGoals = goalManager.getActiveGoals();
    context.goalProgress = [];
    context.usedPatterns = [];
    context.patternMatches = 0;
    context.aiCalls = 0;

    troubleCollector.setCycleId(context.cycleId);
    await troubleCollector.loadRecentTroubles();
    context.troubles = [];

    logger.info("Starting improvement cycle", {
      cycleId: context.cycleId,
      activeGoals: context.activeGoals.length,
    });
    await eventBus.emit({ type: "cycle_started", timestamp: context.startTime });

    // GLMフォールバック変更の確認レビュー
    try {
      await cyclePostProcessor.reviewPendingConfirmations();
    } catch (error) {
      logger.warn("Failed to review pending confirmations", { error });
    }

    try {
      // 8フェーズ実行
      for (const phase of this.phases) {
        logger.info(`Executing phase: ${phase.name}`);

        try {
          const provider = getAIProvider();
          if (provider instanceof HybridProvider) {
            provider.setCurrentPhase(phase.name as PhaseName);
          }
        } catch {
          // Provider not yet initialized, skip
        }

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
          this.lastFailedPhase = phase.name;
          context.failedPhase = phase.name;
          context.failureReason = result.message || `Phase ${phase.name} failed`;
          if (phase.name === "implement" || phase.name === "verify") {
            this.hasCriticalFailure = true;
          }
        }

        if (result.shouldStop) {
          logger.info(`Phase ${phase.name} requested stop`, { message: result.message });
          break;
        }
      }

      // 後処理: フィードバック、抽象化、ドキュメント更新
      await executeFeedbackLoop(context);
      await cyclePostProcessor.run(context);

      // Research: N回に1回、攻めの改善を実行
      if (shouldRunResearch(this.cycleCount)) {
        await executeResearch(context, this.cycleCount);
      }

    } catch (err) {
      const errorMessage = err instanceof Error ? err.message : String(err);
      logger.error("Cycle failed with error", { error: errorMessage });

      if (!context.failedPhase) {
        context.failedPhase = "orchestrator";
      }
      context.failureReason = errorMessage;
      this.hasCriticalFailure = true;

      await eventBus.emit({
        type: "error",
        error: errorMessage,
        context: { cycleId: context.cycleId },
      });

      if (err instanceof Error) {
        await troubleCollector.captureFromError(err, "orchestrator", "runtime-error", "critical");
      }

      const usedPatterns = context.usedPatterns || [];
      for (const patternId of usedPatterns) {
        try {
          patternRepository.updateConfidence(patternId, false);
        } catch (error) {
          logger.warn("Failed to update pattern confidence", { patternId, error });
        }
      }

    } finally {
      this.isRunning = false;
      const duration = Date.now() - context.startTime.getTime();

      if (context.goalProgress && context.goalProgress.length > 0) {
        for (const progress of context.goalProgress) {
          goalManager.recordProgress(
            progress.goalId,
            context.cycleId,
            progress.metricUpdates,
            progress.notes
          );
        }
      }

      try {
        const tokenStats = tokenTracker.saveCycleStats();
        if (tokenStats) {
          context.tokenUsage = {
            totalInput: tokenStats.totalInput,
            totalOutput: tokenStats.totalOutput,
            byPhase: tokenStats.byPhase,
            byProvider: tokenStats.byProvider,
          };
          logger.info("Token usage saved", {
            totalInput: tokenStats.totalInput,
            totalOutput: tokenStats.totalOutput,
          });
        }
      } catch (error) {
        logger.warn("Failed to save token usage", { error });
      }

      try {
        patternRepository.recordCycleCompletion(
          context.patternMatches || 0,
          context.aiCalls || 0
        );
        await patternRepository.save();
      } catch (error) {
        logger.warn("Failed to save learning statistics", { error });
      }

      try {
        const flushedTroubles = await troubleCollector.flush();
        context.troubles = flushedTroubles;
        logger.debug("Flushed troubles", { count: flushedTroubles.length });
      } catch (error) {
        logger.warn("Failed to flush troubles", { error });
      }

      try {
        await improvementQueue.cleanup(ORCHESTRATION.CLEANUP_DAYS);
        await confirmationQueue.cleanup(ORCHESTRATION.CLEANUP_DAYS);
        changeTracker.cleanup(ORCHESTRATION.CLEANUP_DAYS);
      } catch (error) {
        logger.warn("Failed to run queue cleanup", { error });
      }

      try {
        const cycleSuccess = !this.hasCriticalFailure;
        for (const imp of context.improvements) {
          if (imp.source === "queue") {
            await improvementQueue.updateStatus(
              imp.id,
              cycleSuccess ? "completed" : "failed",
              {
                success: cycleSuccess,
                message: cycleSuccess ? "Processed in cycle" : "Cycle failed",
              },
              context.cycleId
            );
          }
        }
      } catch (error) {
        logger.warn("Failed to update improvement queue status", { error });
      }

      await eventBus.emit({
        type: "cycle_completed",
        timestamp: new Date(),
        duration,
      });
      logger.info("Cycle completed", {
        cycleId: context.cycleId,
        duration,
        patternMatches: context.patternMatches,
        aiCalls: context.aiCalls,
        usedPatterns: context.usedPatterns?.length || 0,
        troubles: context.troubles?.length || 0,
      });

      if (context.searchResults) {
        context.searchResults = undefined;
      }
    }

    const troubleCount = context.troubles?.length || 0;
    const cycleSuccess = !this.hasCriticalFailure;

    if (cycleSuccess) {
      this.consecutiveCycleFailures = 0;
    } else {
      this.consecutiveCycleFailures++;
      logger.warn("Cycle failed, consecutive failures increased", {
        consecutiveFailures: this.consecutiveCycleFailures,
        maxAllowed: this.MAX_CONSECUTIVE_FAILURES,
      });

      if (this.consecutiveCycleFailures >= this.MAX_CONSECUTIVE_FAILURES) {
        this.systemPaused = true;
        logger.error("System paused due to consecutive failures", {
          consecutiveFailures: this.consecutiveCycleFailures,
        });
        await eventBus.emit({
          type: "error",
          error: `System paused after ${this.consecutiveCycleFailures} consecutive failures`,
          context: { cycleId: context.cycleId },
        });
      }
    }

    const retryNeeded = cycleSuccess ? false : this.shouldRetryImmediately(context);
    const retryReason = this.getRetryReason(context);
    const quality = this.determineCycleQuality(context, cycleSuccess);

    cycleLogger.saveLog(context, cycleSuccess, false).catch(err => {
      logger.warn("Failed to save cycle log", { error: err });
    });

    return {
      cycleId: context.cycleId,
      success: cycleSuccess,
      duration: Date.now() - context.startTime.getTime(),
      troubleCount,
      shouldRetry: retryNeeded && !this.systemPaused,
      retryReason,
      failedPhase: this.lastFailedPhase || undefined,
      skippedEarly: false,
      quality,
    };
  }

  private shouldRetryImmediately(context: CycleContext): boolean {
    if (context.testResults?.passed === false) return true;
    if (context.troubles && context.troubles.length > 0) return true;
    if (this.hasCriticalFailure) return true;
    return false;
  }

  private getRetryReason(context: CycleContext): string | undefined {
    if (context.testResults?.passed === false) {
      return `Test/Build failed in ${this.lastFailedPhase || "verify"} phase`;
    }
    if (context.troubles && context.troubles.length > 0) {
      return `${context.troubles.length} trouble(s) recorded during cycle`;
    }
    if (this.hasCriticalFailure) {
      return `Critical failure in ${this.lastFailedPhase} phase`;
    }
    return undefined;
  }

  private determineCycleQuality(context: CycleContext, cycleSuccess: boolean): CycleQuality {
    if (!cycleSuccess) return "failed";

    const hasChanges = context.implementedChanges && context.implementedChanges.length > 0;
    const hasTroubles = context.troubles && context.troubles.length > 0;
    const hasIssues = context.issues && context.issues.length > 0;

    if (!hasChanges && hasIssues) return "no-op";
    if (hasTroubles) return "partial";
    if (hasChanges) return "effective";
    return "no-op";
  }

  getLastCycleContext(): CycleContext | null {
    return this.currentContext;
  }

  getStatus(): {
    isRunning: boolean;
    currentCycleId?: string;
    phases: string[];
    consecutiveFailures: number;
    systemPaused: boolean;
  } {
    return {
      isRunning: this.isRunning,
      currentCycleId: this.currentContext?.cycleId,
      phases: this.phases.map((p) => p.name),
      consecutiveFailures: this.consecutiveCycleFailures,
      systemPaused: this.systemPaused,
    };
  }

  resumeSystem(): void {
    if (!this.systemPaused) {
      logger.info("System is not paused");
      return;
    }
    this.systemPaused = false;
    this.consecutiveCycleFailures = 0;
    logger.info("System resumed, consecutive failure counter reset");
  }

  resetFailureCounter(): void {
    this.consecutiveCycleFailures = 0;
    this.systemPaused = false;
  }

  getCycleCount(): number {
    return this.cycleCount;
  }

  async runResearchCycle(): Promise<{
    success: boolean;
    cycleId: string;
    topicsResearched: number;
    totalQueued: number;
    message: string;
  }> {
    if (this.isRunning) {
      return {
        success: false,
        cycleId: "",
        topicsResearched: 0,
        totalQueued: 0,
        message: "A cycle is already running",
      };
    }
    this.isRunning = true;
    try {
      return await runResearchCycleImpl();
    } finally {
      this.isRunning = false;
    }
  }
}

export const orchestrator = new Orchestrator();
