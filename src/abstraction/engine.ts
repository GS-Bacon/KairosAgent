/**
 * Abstraction Engine
 *
 * トラブルを分析し、パターンを抽出し、予防策を生成する統合エンジン
 */

import { readFile, writeFile, mkdir } from "fs/promises";
import { existsSync } from "fs";
import { join, dirname } from "path";

import { Trouble } from "../trouble/types.js";
import {
  TroublePattern,
  PatternStore,
  AbstractionResult,
  AbstractionInput,
  PreventionSuggestion,
} from "./types.js";
import { patternAbstractor } from "./pattern-abstractor.js";
import { preventionGenerator } from "./prevention-generator.js";
import { logger } from "../core/logger.js";

const PATTERN_FILE = join(process.cwd(), "workspace", "trouble-patterns.json");

export class AbstractionEngine {
  private patterns: TroublePattern[] = [];
  private loaded: boolean = false;

  async load(): Promise<void> {
    if (this.loaded) return;

    try {
      if (existsSync(PATTERN_FILE)) {
        const content = await readFile(PATTERN_FILE, "utf-8");
        const store: PatternStore = JSON.parse(content);
        this.patterns = store.patterns || [];
      }
    } catch (error) {
      logger.warn("Failed to load trouble-patterns.json, starting fresh:", { error });
      this.patterns = [];
    }

    this.loaded = true;
  }

  async save(): Promise<void> {
    const store: PatternStore = {
      version: 1,
      patterns: this.patterns,
      lastUpdated: new Date().toISOString(),
    };

    const dir = dirname(PATTERN_FILE);
    if (!existsSync(dir)) {
      await mkdir(dir, { recursive: true });
    }

    await writeFile(PATTERN_FILE, JSON.stringify(store, null, 2));
  }

  /**
   * トラブルを分析してパターンを抽出・更新
   */
  async analyze(input: AbstractionInput): Promise<AbstractionResult> {
    await this.load();

    const { troubles, cycleId } = input;
    const result: AbstractionResult = {
      newPatterns: [],
      updatedPatterns: [],
      preventionSuggestions: [],
      troublesProcessed: 0,
    };

    if (troubles.length === 0) {
      return result;
    }

    // 1. 既存パターンへのマッチングを試行
    const unmatchedTroubles: Trouble[] = [];

    for (const trouble of troubles) {
      const match = patternAbstractor.matchToExistingPatterns(
        trouble,
        this.patterns
      );

      if (match) {
        // 既存パターンを更新
        const pattern = match.pattern;
        pattern.occurrenceCount++;
        pattern.troubleIds.push(trouble.id);
        pattern.lastOccurredAt = new Date().toISOString();
        pattern.updatedAt = new Date().toISOString();

        // 信頼度を増加（最大1.0）
        pattern.confidence = Math.min(1.0, pattern.confidence + 0.05);

        if (!result.updatedPatterns.find((p) => p.id === pattern.id)) {
          result.updatedPatterns.push(pattern);
        }

        logger.debug("Matched trouble to existing pattern", {
          troubleId: trouble.id,
          patternId: pattern.id,
          confidence: match.confidence,
        });
      } else {
        unmatchedTroubles.push(trouble);
      }

      result.troublesProcessed++;
    }

    // 2. 未マッチのトラブルをグルーピングして新パターンを抽出
    if (unmatchedTroubles.length >= 2) {
      const groups = patternAbstractor.groupSimilarTroubles(unmatchedTroubles);

      for (const group of groups) {
        if (group.length >= 2) {
          const newPattern = patternAbstractor.extractNewPattern(group);
          if (newPattern) {
            this.patterns.push(newPattern);
            result.newPatterns.push(newPattern);

            logger.info("Extracted new pattern", {
              patternId: newPattern.id,
              name: newPattern.name,
              troubleCount: group.length,
            });
          }
        }
      }
    }

    // 3. 新規・更新パターンに対して予防策を生成
    const patternsToProcess = [...result.newPatterns, ...result.updatedPatterns];

    for (const pattern of patternsToProcess) {
      // 予防策がまだないパターン、または発生回数が閾値を超えたパターン
      if (
        pattern.preventionSuggestions.length === 0 ||
        pattern.occurrenceCount >= 5
      ) {
        const suggestions = await preventionGenerator.generate({
          pattern,
          recentTroubles: troubles.filter((t) =>
            pattern.troubleIds.includes(t.id)
          ),
          existingSuggestions: pattern.preventionSuggestions,
        });

        if (suggestions.length > 0) {
          pattern.preventionSuggestions.push(...suggestions);
          result.preventionSuggestions.push(...suggestions);

          logger.info("Generated prevention suggestions", {
            patternId: pattern.id,
            count: suggestions.length,
          });
        }
      }
    }

    // 4. 保存
    await this.save();

    logger.info("Abstraction analysis completed", {
      troublesProcessed: result.troublesProcessed,
      newPatterns: result.newPatterns.length,
      updatedPatterns: result.updatedPatterns.length,
      preventionSuggestions: result.preventionSuggestions.length,
    });

    return result;
  }

  /**
   * 全パターンを取得
   */
  async getPatterns(): Promise<TroublePattern[]> {
    await this.load();
    return [...this.patterns];
  }

  /**
   * パターンを取得
   */
  async getPattern(id: string): Promise<TroublePattern | null> {
    await this.load();
    return this.patterns.find((p) => p.id === id) || null;
  }

  /**
   * 高頻度パターンを取得
   */
  async getFrequentPatterns(minOccurrences: number = 3): Promise<TroublePattern[]> {
    await this.load();
    return this.patterns
      .filter((p) => p.occurrenceCount >= minOccurrences)
      .sort((a, b) => b.occurrenceCount - a.occurrenceCount);
  }

  /**
   * 未適用の予防策を取得
   */
  async getUnappliedPreventions(): Promise<
    Array<{ pattern: TroublePattern; suggestion: PreventionSuggestion }>
  > {
    await this.load();

    const result: Array<{
      pattern: TroublePattern;
      suggestion: PreventionSuggestion;
    }> = [];

    for (const pattern of this.patterns) {
      for (const suggestion of pattern.preventionSuggestions) {
        if (!suggestion.appliedAt) {
          result.push({ pattern, suggestion });
        }
      }
    }

    return result;
  }

  /**
   * 予防策を適用済みとしてマーク
   */
  async markPreventionApplied(
    patternId: string,
    suggestionId: string
  ): Promise<boolean> {
    await this.load();

    const pattern = this.patterns.find((p) => p.id === patternId);
    if (!pattern) return false;

    const suggestion = pattern.preventionSuggestions.find(
      (s) => s.id === suggestionId
    );
    if (!suggestion) return false;

    suggestion.appliedAt = new Date().toISOString();
    await this.save();
    return true;
  }

  /**
   * パターンの信頼度を更新
   */
  async updatePatternConfidence(
    patternId: string,
    delta: number
  ): Promise<void> {
    await this.load();

    const pattern = this.patterns.find((p) => p.id === patternId);
    if (pattern) {
      pattern.confidence = Math.max(0, Math.min(1, pattern.confidence + delta));
      pattern.updatedAt = new Date().toISOString();
      await this.save();
    }
  }

  /**
   * 統計情報を取得
   */
  async getStats(): Promise<{
    totalPatterns: number;
    totalOccurrences: number;
    avgConfidence: number;
    totalPreventions: number;
    appliedPreventions: number;
  }> {
    await this.load();

    let totalOccurrences = 0;
    let totalConfidence = 0;
    let totalPreventions = 0;
    let appliedPreventions = 0;

    for (const pattern of this.patterns) {
      totalOccurrences += pattern.occurrenceCount;
      totalConfidence += pattern.confidence;
      totalPreventions += pattern.preventionSuggestions.length;
      appliedPreventions += pattern.preventionSuggestions.filter(
        (s) => s.appliedAt
      ).length;
    }

    return {
      totalPatterns: this.patterns.length,
      totalOccurrences,
      avgConfidence:
        this.patterns.length > 0 ? totalConfidence / this.patterns.length : 0,
      totalPreventions,
      appliedPreventions,
    };
  }
}

export const abstractionEngine = new AbstractionEngine();
