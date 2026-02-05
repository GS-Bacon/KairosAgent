import { logger } from "./logger.js";
import { eventBus } from "./event-bus.js";
import { Phase, CycleContext, CycleResult, createCycleContext } from "../phases/types.js";
import { goalManager } from "../goals/index.js";
import { getAIProvider } from "../ai/factory.js";
import { HybridProvider, PhaseName } from "../ai/hybrid-provider.js";

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
  patternExtractor,
  initializeLearningSystem,
  ExtractionContext,
} from "../learning/index.js";
import { troubleCollector } from "../trouble/index.js";
import { abstractionEngine } from "../abstraction/index.js";
import {
  improvementQueue,
  collectFromAbstraction,
} from "../improvement-queue/index.js";

export class Orchestrator {
  private phases: Phase[];
  private isRunning: boolean = false;
  private currentContext: CycleContext | null = null;
  private lastFailedPhase: string | null = null;
  private hasCriticalFailure: boolean = false;
  private consecutiveCycleFailures: number = 0;
  private systemPaused: boolean = false;
  private readonly MAX_CONSECUTIVE_FAILURES = 5;

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

    // システム一時停止中のチェック
    if (this.systemPaused) {
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
      };
    }

    this.isRunning = true;
    this.lastFailedPhase = null;
    this.hasCriticalFailure = false;
    const context = createCycleContext();
    this.currentContext = context;

    // Initialize learning system
    try {
      await initializeLearningSystem();
    } catch (error) {
      logger.warn("Failed to initialize learning system", { error });
    }

    // Load active goals into context
    context.activeGoals = goalManager.getActiveGoals();
    context.goalProgress = [];

    // Initialize learning context
    context.usedPatterns = [];
    context.patternMatches = 0;
    context.aiCalls = 0;

    // Initialize trouble collector
    troubleCollector.setCycleId(context.cycleId);
    await troubleCollector.loadRecentTroubles(); // 重複チェック用キャッシュをロード
    context.troubles = [];

    logger.info("Starting improvement cycle", {
      cycleId: context.cycleId,
      activeGoals: context.activeGoals.length,
    });
    await eventBus.emit({ type: "cycle_started", timestamp: context.startTime });

    try {
      for (const phase of this.phases) {
        logger.info(`Executing phase: ${phase.name}`);

        // Set current phase on hybrid provider if in use
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
          // Phase 6 (implement) や Phase 8 (verify) の失敗は重大
          if (phase.name === "implement" || phase.name === "verify") {
            this.hasCriticalFailure = true;
          }
        }

        if (result.shouldStop) {
          logger.info(`Phase ${phase.name} requested stop`, { message: result.message });
          break;
        }
      }

      // Feedback Loop: パターン学習と信頼度更新
      await this.executeFeedbackLoop(context);

      // Trouble Abstraction: トラブルパターンの抽出と改善キュー追加
      await this.executeAbstraction(context);

    } catch (err) {
      const errorMessage = err instanceof Error ? err.message : String(err);
      logger.error("Cycle failed with error", { error: errorMessage });
      await eventBus.emit({
        type: "error",
        error: errorMessage,
        context: { cycleId: context.cycleId },
      });

      // サイクルエラーをトラブルとして記録
      if (err instanceof Error) {
        await troubleCollector.captureFromError(err, "orchestrator", "runtime-error", "critical");
      }

      // 失敗時も使用パターンの信頼度を更新
      await this.updatePatternConfidence(context, false);

    } finally {
      this.isRunning = false;
      const duration = Date.now() - context.startTime.getTime();

      // Record goal progress if any
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

      // Record learning statistics
      try {
        patternRepository.recordCycleCompletion(
          context.patternMatches || 0,
          context.aiCalls || 0
        );
        await patternRepository.save();
      } catch (error) {
        logger.warn("Failed to save learning statistics", { error });
      }

      // Flush troubles to repository
      try {
        const flushedTroubles = await troubleCollector.flush();
        context.troubles = flushedTroubles;
        logger.debug("Flushed troubles", { count: flushedTroubles.length });
      } catch (error) {
        logger.warn("Failed to flush troubles", { error });
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
    }

    // CycleResult を構築して返す
    const troubleCount = context.troubles?.length || 0;
    const cycleSuccess = !this.hasCriticalFailure;

    // 連続失敗カウンターの更新
    if (cycleSuccess) {
      this.consecutiveCycleFailures = 0;
      logger.debug("Cycle succeeded, consecutive failure counter reset");
    } else {
      this.consecutiveCycleFailures++;
      logger.warn("Cycle failed, consecutive failures increased", {
        consecutiveFailures: this.consecutiveCycleFailures,
        maxAllowed: this.MAX_CONSECUTIVE_FAILURES,
      });

      // 5回連続失敗でシステム一時停止
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

    const shouldRetry = cycleSuccess ? false : this.shouldRetryImmediately(context);
    const retryReason = this.getRetryReason(context);

    return {
      cycleId: context.cycleId,
      success: cycleSuccess,
      duration: Date.now() - context.startTime.getTime(),
      troubleCount,
      shouldRetry: shouldRetry && !this.systemPaused, // 一時停止中はリトライしない
      retryReason,
      failedPhase: this.lastFailedPhase || undefined,
    };
  }

  /**
   * 即時再実行が必要かどうかを判定
   */
  private shouldRetryImmediately(context: CycleContext): boolean {
    // ビルド/テスト失敗
    if (context.testResults?.passed === false) {
      return true;
    }
    // 新しいトラブルが発生した
    if (context.troubles && context.troubles.length > 0) {
      return true;
    }
    // 重大なフェーズ失敗
    if (this.hasCriticalFailure) {
      return true;
    }
    return false;
  }

  /**
   * 再実行理由を取得
   */
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

  /**
   * Feedback Loop: サイクル完了後にパターン学習と信頼度更新
   */
  private async executeFeedbackLoop(context: CycleContext): Promise<void> {
    const testSuccess = context.testResults?.passed === true;

    if (testSuccess) {
      // 解決成功 → パターン学習
      await this.extractAndSavePatterns(context);
    }

    // 使用したパターンの信頼度を更新
    await this.updatePatternConfidence(context, testSuccess);
  }

  /**
   * 解決からパターンを抽出して保存
   */
  private async extractAndSavePatterns(context: CycleContext): Promise<void> {
    if (!context.plan || !context.implementedChanges) {
      return;
    }

    try {
      // 問題と解決策から抽出コンテキストを作成
      const extractionContexts: ExtractionContext[] = [];

      // Issues からの抽出
      for (const issue of context.issues) {
        if (context.plan.targetIssue?.id === issue.id) {
          extractionContexts.push({
            problem: {
              type: issue.type,
              description: issue.message,
              file: issue.file || "",
            },
            solution: {
              description: context.plan.description,
              changes: context.implementedChanges.map((c) => ({
                file: c.file,
                before: "", // 実際の変更内容は取得困難なため空
                after: "",
              })),
            },
            success: true,
          });
        }
      }

      // Improvements からの抽出
      for (const improvement of context.improvements) {
        if (context.plan.targetImprovement?.id === improvement.id) {
          extractionContexts.push({
            problem: {
              type: improvement.type,
              description: improvement.description,
              file: improvement.file,
            },
            solution: {
              description: context.plan.description,
              changes: context.implementedChanges.map((c) => ({
                file: c.file,
                before: "",
                after: "",
              })),
            },
            success: true,
          });
        }
      }

      if (extractionContexts.length > 0) {
        const newPatterns = await patternExtractor.extractPatterns(extractionContexts);

        if (newPatterns.length > 0) {
          await patternRepository.addAndSavePatterns(newPatterns);
          logger.info("New patterns learned", {
            count: newPatterns.length,
            patterns: newPatterns.map((p) => p.name),
          });
        }
      }
    } catch (error) {
      logger.warn("Failed to extract patterns", { error });
    }
  }

  /**
   * トラブル抽象化と改善キュー追加
   */
  private async executeAbstraction(context: CycleContext): Promise<void> {
    const troubles = context.troubles || [];

    if (troubles.length === 0) {
      logger.debug("No troubles to abstract");
      return;
    }

    try {
      // トラブルパターンを分析
      const result = await abstractionEngine.analyze({
        troubles,
        existingPatterns: await abstractionEngine.getPatterns(),
        cycleId: context.cycleId,
      });

      logger.info("Abstraction completed", {
        newPatterns: result.newPatterns.length,
        updatedPatterns: result.updatedPatterns.length,
        preventionSuggestions: result.preventionSuggestions.length,
      });

      // 予防策を改善キューに追加
      if (result.preventionSuggestions.length > 0) {
        const collected = await collectFromAbstraction();
        logger.info("Collected improvements from abstraction", {
          count: collected,
        });
      }
    } catch (error) {
      logger.warn("Failed to execute abstraction", { error });
    }
  }

  /**
   * 使用したパターンの信頼度を更新
   */
  private async updatePatternConfidence(
    context: CycleContext,
    success: boolean
  ): Promise<void> {
    const usedPatterns = context.usedPatterns || [];

    for (const patternId of usedPatterns) {
      try {
        patternRepository.updateConfidence(patternId, success);
        logger.debug("Pattern confidence updated", {
          patternId,
          success,
        });
      } catch (error) {
        logger.warn("Failed to update pattern confidence", { patternId, error });
      }
    }
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

  /**
   * システム一時停止を解除
   */
  resumeSystem(): void {
    if (!this.systemPaused) {
      logger.info("System is not paused");
      return;
    }
    this.systemPaused = false;
    this.consecutiveCycleFailures = 0;
    logger.info("System resumed, consecutive failure counter reset");
  }

  /**
   * 連続失敗カウンターをリセット（テスト用）
   */
  resetFailureCounter(): void {
    this.consecutiveCycleFailures = 0;
    this.systemPaused = false;
  }
}

export const orchestrator = new Orchestrator();
