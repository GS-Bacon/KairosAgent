/**
 * Improvement Collectors
 *
 * 各フェーズからの改善提案を収集し、キューに追加する
 */

import { improvementQueue } from "../queue.js";
import { QueuedImprovementInput, ImprovementSource } from "../types.js";
import { abstractionEngine, TroublePattern, PreventionSuggestion } from "../../abstraction/index.js";
import { Trouble } from "../../trouble/types.js";
import { logger } from "../../core/logger.js";

/**
 * トラブル抽象化からの改善提案を収集
 */
export async function collectFromAbstraction(): Promise<number> {
  try {
    const unapplied = await abstractionEngine.getUnappliedPreventions();

    let enqueued = 0;
    for (const { pattern, suggestion } of unapplied) {
      // 重複チェック
      const isDuplicate = await improvementQueue.isDuplicate(
        suggestion.description,
        suggestion.implementation || ""
      );

      if (!isDuplicate) {
        await improvementQueue.enqueue({
          source: "trouble-abstraction",
          type: mapPreventionTypeToImprovementType(suggestion.type),
          title: suggestion.description,
          description: suggestion.implementation || suggestion.description,
          priority: calculatePriority(pattern, suggestion),
          relatedPatternId: pattern.id,
          preventionSuggestionId: suggestion.id,
          metadata: {
            patternName: pattern.name,
            occurrenceCount: pattern.occurrenceCount,
            automated: suggestion.automated,
          },
        });
        enqueued++;
      }
    }

    if (enqueued > 0) {
      logger.info("Collected improvements from abstraction", { count: enqueued });
    }

    return enqueued;
  } catch (error) {
    logger.warn("Failed to collect from abstraction", { error });
    return 0;
  }
}

/**
 * 高頻度パターンからの改善提案を収集
 */
export async function collectFromFrequentPatterns(
  minOccurrences: number = 3
): Promise<number> {
  try {
    const patterns = await abstractionEngine.getFrequentPatterns(minOccurrences);

    let enqueued = 0;
    for (const pattern of patterns) {
      // まだ適用されていない予防策があるパターン
      const unappliedSuggestions = pattern.preventionSuggestions.filter(
        (s) => !s.appliedAt
      );

      for (const suggestion of unappliedSuggestions) {
        const isDuplicate = await improvementQueue.isDuplicate(
          suggestion.description,
          suggestion.implementation || ""
        );

        if (!isDuplicate) {
          await improvementQueue.enqueue({
            source: "trouble-abstraction",
            type: mapPreventionTypeToImprovementType(suggestion.type),
            title: `[${pattern.name}] ${suggestion.description}`,
            description: suggestion.implementation || suggestion.description,
            priority: calculatePriority(pattern, suggestion) + 10, // 高頻度パターンは優先度上げ
            relatedPatternId: pattern.id,
            preventionSuggestionId: suggestion.id,
            metadata: {
              patternName: pattern.name,
              occurrenceCount: pattern.occurrenceCount,
              automated: suggestion.automated,
            },
          });
          enqueued++;
        }
      }
    }

    if (enqueued > 0) {
      logger.info("Collected improvements from frequent patterns", { count: enqueued });
    }

    return enqueued;
  } catch (error) {
    logger.warn("Failed to collect from frequent patterns", { error });
    return 0;
  }
}

/**
 * フェーズからの改善提案を追加
 */
export async function enqueueFromPhase(
  phaseName: string,
  improvements: Array<{
    title: string;
    description: string;
    priority?: number;
    file?: string;
    type?: string;
  }>
): Promise<number> {
  const source = `phase-${phaseName}` as ImprovementSource;

  let enqueued = 0;
  for (const imp of improvements) {
    const isDuplicate = await improvementQueue.isDuplicate(
      imp.title,
      imp.description
    );

    if (!isDuplicate) {
      await improvementQueue.enqueue({
        source,
        type: mapStringToImprovementType(imp.type),
        title: imp.title,
        description: imp.description,
        priority: imp.priority ?? 50,
        relatedFile: imp.file,
      });
      enqueued++;
    }
  }

  return enqueued;
}

/**
 * 優先度を計算
 */
function calculatePriority(
  pattern: TroublePattern,
  suggestion: PreventionSuggestion
): number {
  let priority = 50;

  // パターンの発生回数で優先度を上げる
  priority += Math.min(20, pattern.occurrenceCount * 2);

  // 信頼度が高いパターンは優先度を上げる
  priority += Math.round(pattern.confidence * 10);

  // 自動化可能な場合は優先度を上げる
  if (suggestion.automated) {
    priority += 5;
  }

  // 予防策自体の信頼度
  priority += Math.round(suggestion.confidence * 10);

  return Math.min(100, priority);
}

/**
 * PreventionTypeをImprovementTypeにマッピング
 */
function mapPreventionTypeToImprovementType(
  preventionType: string
): QueuedImprovementInput["type"] {
  const mapping: Record<string, QueuedImprovementInput["type"]> = {
    "naming-convention": "documentation",
    "lint-rule": "tooling",
    "pre-commit": "tooling",
    architecture: "refactor",
    testing: "testing",
    documentation: "documentation",
    tooling: "tooling",
    process: "documentation",
  };

  return mapping[preventionType] || "refactor";
}

/**
 * 文字列をImprovementTypeにマッピング
 */
function mapStringToImprovementType(
  typeStr?: string
): QueuedImprovementInput["type"] {
  const mapping: Record<string, QueuedImprovementInput["type"]> = {
    "bug-fix": "bug-fix",
    bugfix: "bug-fix",
    bug: "bug-fix",
    feature: "feature",
    refactor: "refactor",
    prevention: "prevention",
    documentation: "documentation",
    doc: "documentation",
    tooling: "tooling",
    tool: "tooling",
    testing: "testing",
    test: "testing",
    security: "security",
    performance: "performance",
    perf: "performance",
  };

  return mapping[typeStr?.toLowerCase() || ""] || "refactor";
}
