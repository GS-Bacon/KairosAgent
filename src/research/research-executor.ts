/**
 * Research Executor
 *
 * リサーチフェーズの実行ロジック
 * orchestrator.tsから抽出
 */

import { CycleContext, ResearchCycleData } from "../phases/types.js";
import { ClaudeProvider } from "../ai/claude-provider.js";
import { Researcher, approachExplorer } from "./index.js";
import { cycleLogger } from "../core/cycle-logger.js";
import { goalManager } from "../goals/index.js";
import { logger } from "../core/logger.js";
import { getConfig } from "../config/config.js";
import type { ResearchResult } from "./types.js";

/**
 * リサーチ実行条件をチェック
 */
export function shouldRunResearch(cycleCount: number): boolean {
  const config = getConfig();
  if (!config.research.enabled) {
    return false;
  }
  return cycleCount % config.research.frequency === 0;
}

/**
 * Research（攻めの改善）を実行
 */
export async function executeResearch(context: CycleContext, cycleCount: number): Promise<void> {
  const config = getConfig();
  const activeGoals = context.activeGoals || [];

  if (activeGoals.length === 0) {
    logger.debug("No active goals for research");
    return;
  }

  logger.info("Starting Research phase", {
    cycleCount,
    frequency: config.research.frequency,
    activeGoals: activeGoals.length,
  });

  try {
    const claude = new ClaudeProvider({ planModel: "opus" });
    const researcher = new Researcher(claude);

    const topics = researcher.extractTopics(activeGoals);
    const topicsToResearch = topics.slice(0, config.research.maxTopicsPerCycle);

    logger.info("Research topics extracted", {
      totalTopics: topics.length,
      toResearch: topicsToResearch.length,
    });

    let totalQueued = 0;

    for (const topic of topicsToResearch) {
      try {
        const result = await researcher.research(topic);
        const queuedCount = await approachExplorer.processResearchResult(result);
        totalQueued += queuedCount;

        logger.info("Research topic completed", {
          topic: topic.topic,
          findings: result.findings.length,
          approaches: result.approaches.length,
          queued: queuedCount,
        });

        const researchData: ResearchCycleData = {
          type: "research",
          topic: {
            id: result.topic.id,
            topic: result.topic.topic,
            source: result.topic.source,
            priority: result.topic.priority,
            relatedGoalId: result.topic.relatedGoalId,
          },
          findings: result.findings.map(f => ({
            source: f.source,
            summary: f.summary,
            relevance: f.relevance,
          })),
          approaches: result.approaches.map(a => ({
            id: a.id,
            description: a.description,
            pros: a.pros,
            cons: a.cons,
            estimatedEffort: a.estimatedEffort,
            confidence: a.confidence,
          })),
          recommendations: result.recommendations,
          queuedImprovements: queuedCount,
        };
        context.cycleData = researchData;

        await cycleLogger.saveLog(context, true, false);
        await saveResearchJsonBackup(result);
      } catch (err) {
        logger.warn("Research topic failed", {
          topic: topic.topic,
          error: err instanceof Error ? err.message : String(err),
        });
      }
    }

    logger.info("Research phase completed", {
      topicsResearched: topicsToResearch.length,
      totalQueued,
    });
  } catch (err) {
    logger.error("Research phase failed", {
      error: err instanceof Error ? err.message : String(err),
    });
  }
}

/**
 * Research結果のJSONバックアップを保存
 */
async function saveResearchJsonBackup(result: ResearchResult): Promise<void> {
  try {
    const { writeFileSync, existsSync, mkdirSync } = await import("fs");
    const logDir = "./workspace/logs/research-json";
    if (!existsSync(logDir)) {
      mkdirSync(logDir, { recursive: true });
    }

    const date = new Date().toISOString().split("T")[0];
    const filename = `${logDir}/${date}-research-${result.topic.id}.json`;
    writeFileSync(filename, JSON.stringify(result, null, 2));
    logger.debug("Research JSON backup saved", { filename });
  } catch (err) {
    logger.warn("Failed to save research JSON backup", {
      error: err instanceof Error ? err.message : String(err),
    });
  }
}

/**
 * リサーチサイクルを強制実行（API用）
 */
export async function runResearchCycle(): Promise<{
  success: boolean;
  cycleId: string;
  topicsResearched: number;
  totalQueued: number;
  message: string;
}> {
  const config = getConfig();
  const cycleId = `research-${Date.now()}`;

  try {
    logger.info("Starting forced research cycle", { cycleId });

    const activeGoals = goalManager.getActiveGoals();
    if (activeGoals.length === 0) {
      return {
        success: false,
        cycleId,
        topicsResearched: 0,
        totalQueued: 0,
        message: "No active goals for research",
      };
    }

    const claude = new ClaudeProvider({ planModel: "opus" });
    const researcher = new Researcher(claude);

    const topics = researcher.extractTopics(activeGoals);
    const topicsToResearch = topics.slice(0, config.research.maxTopicsPerCycle);

    logger.info("Research topics extracted", {
      totalTopics: topics.length,
      toResearch: topicsToResearch.length,
    });

    let totalQueued = 0;

    for (const topic of topicsToResearch) {
      try {
        const result = await researcher.research(topic);
        const queuedCount = await approachExplorer.processResearchResult(result);
        totalQueued += queuedCount;

        await saveResearchJsonBackup(result);

        logger.info("Research topic completed", {
          topic: topic.topic,
          findings: result.findings.length,
          approaches: result.approaches.length,
          queued: queuedCount,
        });
      } catch (err) {
        logger.error("Research topic failed", {
          topic: topic.topic,
          error: err instanceof Error ? err.message : String(err),
        });
      }
    }

    return {
      success: true,
      cycleId,
      topicsResearched: topicsToResearch.length,
      totalQueued,
      message: `Research completed: ${topicsToResearch.length} topics, ${totalQueued} improvements queued`,
    };
  } catch (err) {
    logger.error("Research cycle failed", {
      error: err instanceof Error ? err.message : String(err),
    });
    return {
      success: false,
      cycleId,
      topicsResearched: 0,
      totalQueued: 0,
      message: err instanceof Error ? err.message : "Unknown error",
    };
  }
}
