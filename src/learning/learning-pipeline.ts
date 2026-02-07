/**
 * Learning Pipeline
 *
 * サイクル完了後のパターン学習と信頼度更新を担当
 * orchestrator.tsから抽出
 */

import { CycleContext } from "../phases/types.js";
import {
  patternRepository,
  patternExtractor,
  ExtractionContext,
} from "./index.js";
import { abstractionEngine } from "../abstraction/index.js";
import { logger } from "../core/logger.js";
import type { Trouble } from "../trouble/types.js";

/**
 * Feedback Loop: サイクル完了後にパターン学習と信頼度更新
 */
export async function executeFeedbackLoop(context: CycleContext): Promise<void> {
  const testSuccess = context.testResults?.passed === true;

  if (testSuccess) {
    await extractAndSavePatterns(context);
  } else {
    await recordFailedApproach(context);
  }

  await updatePatternConfidence(context, testSuccess);
}

/**
 * テスト/ビルド失敗時にanti-patternとしてtrouble-patterns.jsonに記録
 */
async function recordFailedApproach(context: CycleContext): Promise<void> {
  if (!context.plan && !context.failedPhase) {
    return;
  }

  try {
    const failureTroubles: Trouble[] = [];
    const now = new Date().toISOString();

    if (context.testResults?.passed === false) {
      const errorOutput = context.testResults.errors?.join("; ").slice(0, 500) || "Unknown test failure";
      failureTroubles.push({
        id: `anti-${context.cycleId}-test`,
        cycleId: context.cycleId,
        phase: context.failedPhase || "verify",
        category: "test-failure",
        severity: "high",
        message: `Failed approach: ${context.plan?.description || "unknown plan"}. Error: ${errorOutput}`,
        file: context.plan?.targetIssue?.file || context.implementedChanges?.[0]?.file,
        context: {
          antiPattern: true,
          planDescription: context.plan?.description,
          targetIssue: context.plan?.targetIssue?.id,
          changedFiles: context.implementedChanges?.map(c => c.file) || [],
        },
        resolved: false,
        occurredAt: now,
      });
    }

    if (context.failedPhase) {
      const failureReason = context.failureReason || "Unknown failure";
      if (!failureTroubles.some(t => t.phase === context.failedPhase)) {
        failureTroubles.push({
          id: `anti-${context.cycleId}-${context.failedPhase}`,
          cycleId: context.cycleId,
          phase: context.failedPhase,
          category: "build-error",
          severity: "high",
          message: `Failed approach in ${context.failedPhase}: ${failureReason}`,
          file: context.implementedChanges?.[0]?.file,
          context: {
            antiPattern: true,
            planDescription: context.plan?.description,
            failureReason,
          },
          resolved: false,
          occurredAt: now,
        });
      }
    }

    if (failureTroubles.length > 0) {
      await abstractionEngine.analyze({
        troubles: failureTroubles,
        existingPatterns: await abstractionEngine.getPatterns(),
        cycleId: context.cycleId,
      });

      logger.info("Recorded failed approach as anti-pattern", {
        cycleId: context.cycleId,
        failedPhase: context.failedPhase,
        troubleCount: failureTroubles.length,
      });
    }
  } catch (error) {
    logger.warn("Failed to record anti-pattern", { error });
  }
}

/**
 * 解決からパターンを抽出して保存
 */
async function extractAndSavePatterns(context: CycleContext): Promise<void> {
  if (!context.plan || !context.implementedChanges) {
    return;
  }

  try {
    const extractionContexts: ExtractionContext[] = [];

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
              before: "",
              after: "",
            })),
          },
          success: true,
        });
      }
    }

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
 * 使用したパターンの信頼度を更新
 */
async function updatePatternConfidence(
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
