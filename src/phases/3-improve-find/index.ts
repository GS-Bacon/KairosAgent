import fs from "fs";
import path from "path";
import { Phase, PhaseResult, CycleContext, Improvement } from "../types.js";
import { ImprovementFinder } from "./finder.js";
import { GoalBasedAnalyzer } from "./goal-analyzer.js";
import { logger } from "../../core/logger.js";
import { toolTracker } from "../../tools/index.js";
import {
  ruleEngine,
  aiAnalyzer,
  PatternMatch,
  AIImprovement,
} from "../../learning/index.js";
import { improvementQueue, QueuedImprovement } from "../../improvement-queue/index.js";

export class ImproveFindPhase implements Phase {
  name = "improve-find";
  private finder: ImprovementFinder;
  private goalAnalyzer: GoalBasedAnalyzer;

  constructor() {
    this.finder = new ImprovementFinder();
    this.goalAnalyzer = new GoalBasedAnalyzer();
  }

  async execute(context: CycleContext): Promise<PhaseResult> {
    logger.debug("Finding improvement opportunities");

    // 学習システムの初期化
    context.usedPatterns = [];
    context.patternMatches = 0;
    context.aiCalls = 0;

    // 1. 既存のルールベース検索（TODO/FIXME等）
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

    // 2. 学習済みパターンでマッチング
    const sourceFiles = this.getSourceFiles();
    let patternMatches: PatternMatch[] = [];

    try {
      await ruleEngine.initialize();
      patternMatches = await ruleEngine.matchAll(sourceFiles);

      // パターンマッチを改善として追加
      for (const match of patternMatches) {
        context.improvements.push({
          id: `pat_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`,
          type: "optimization",
          description: `[Pattern: ${match.patternName}] ${match.matchedContent.substring(0, 100)}`,
          file: match.file,
          line: match.line,
          priority: match.confidence > 0.8 ? "high" : "medium",
        });

        // 使用したパターンを記録
        if (!context.usedPatterns!.includes(match.patternId)) {
          context.usedPatterns!.push(match.patternId);
        }
      }

      context.patternMatches = patternMatches.length;
      logger.info("Pattern matching completed", {
        matches: patternMatches.length,
        patterns: context.usedPatterns!.length,
      });
    } catch (error) {
      logger.warn("Pattern matching failed, continuing without", { error });
    }

    // 3. 未カバー領域のみAI分析（オプション）
    const coveredFiles = new Set([
      ...result.markers.map((m) => m.file),
      ...result.qualityIssues.map((i) => i.file),
      ...patternMatches.map((m) => m.file),
    ]);

    const uncoveredFiles = sourceFiles.filter((f) => !coveredFiles.has(f));

    // AI分析は未カバーファイルが多い場合のみ実行
    if (uncoveredFiles.length > 0 && uncoveredFiles.length <= 10) {
      try {
        const aiImprovements = await aiAnalyzer.analyzeImprovements(uncoveredFiles, {
          files: uncoveredFiles,
          existingIssues: context.issues.map((i) => i.message),
          codebaseRoot: process.cwd(),
        });

        for (const aiImp of aiImprovements) {
          context.improvements.push({
            id: aiImp.id,
            type: this.mapAITypeToImprovement(aiImp.type),
            description: `[AI] ${aiImp.description}`,
            file: aiImp.file,
            line: aiImp.line,
            priority: aiImp.priority,
          });
        }

        context.aiCalls = (context.aiCalls || 0) + 1;
        logger.info("AI analysis completed", {
          improvements: aiImprovements.length,
        });
      } catch (error) {
        logger.debug("AI analysis skipped or failed", { error });
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

    // 4. 改善キューから優先度の高い項目を取得
    try {
      const queuedImprovements = await improvementQueue.getPending(5);
      for (const queued of queuedImprovements) {
        context.improvements.push(this.mapQueuedToImprovement(queued));
      }
      logger.debug("Added queued improvements", { count: queuedImprovements.length });
    } catch (error) {
      logger.debug("Failed to get queued improvements", { error });
    }

    // 5. 目標ベースの改善検出
    let goalImprovementsCount = 0;
    if (context.activeGoals && context.activeGoals.length > 0) {
      try {
        const goalImprovements = this.goalAnalyzer.analyzeForGoals(
          context.activeGoals,
          sourceFiles
        );

        for (const goalImp of goalImprovements) {
          context.improvements.push(goalImp.improvement);
          goalImprovementsCount++;
        }

        if (goalImprovementsCount > 0) {
          logger.info("Goal-based improvements found", {
            count: goalImprovementsCount,
            goals: context.activeGoals.map((g) => g.title),
          });
        }
      } catch (error) {
        logger.debug("Goal-based analysis failed", { error });
      }
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
      patternMatches: context.patternMatches,
      goalImprovements: goalImprovementsCount,
      aiCalls: context.aiCalls,
      totalImprovements,
    });

    return {
      success: true,
      shouldStop: false,
      message: `Found ${totalIssues} issues, ${totalImprovements} improvements (${context.patternMatches} patterns, ${goalImprovementsCount} from goals)`,
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

  private getSourceFiles(): string[] {
    const files: string[] = [];

    const collectFiles = (dir: string) => {
      if (!fs.existsSync(dir)) return;

      const entries = fs.readdirSync(dir);
      for (const entry of entries) {
        const fullPath = path.join(dir, entry);
        const stat = fs.statSync(fullPath);

        if (stat.isDirectory()) {
          if (!["node_modules", ".git", "dist"].includes(entry)) {
            collectFiles(fullPath);
          }
        } else if (entry.endsWith(".ts") || entry.endsWith(".js")) {
          files.push(fullPath);
        }
      }
    };

    collectFiles(path.join(process.cwd(), "src"));
    return files;
  }

  private mapAITypeToImprovement(
    aiType: string
  ): "todo" | "fixme" | "optimization" | "refactor" | "security" | "tool-adoption" {
    switch (aiType) {
      case "security":
        return "security";
      case "bug-fix":
        return "fixme";
      case "refactor":
        return "refactor";
      case "optimization":
        return "optimization";
      default:
        return "optimization";
    }
  }

  private mapQueuedToImprovement(queued: QueuedImprovement): Improvement {
    const typeMapping: Record<string, Improvement["type"]> = {
      "bug-fix": "fixme",
      feature: "todo",
      refactor: "refactor",
      prevention: "optimization",
      documentation: "todo",
      tooling: "tool-adoption",
      testing: "todo",
      security: "security",
      performance: "optimization",
    };

    return {
      id: queued.id,
      type: typeMapping[queued.type] || "optimization",
      description: `[Queue: ${queued.source}] ${queued.title}`,
      file: queued.relatedFile || "",
      priority: queued.priority > 70 ? "high" : queued.priority > 40 ? "medium" : "low",
    };
  }
}

export { ImprovementFinder } from "./finder.js";
export * from "./types.js";
