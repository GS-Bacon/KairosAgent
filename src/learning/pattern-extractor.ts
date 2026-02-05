/**
 * Pattern Extractor - パターン抽出・学習機構
 *
 * AI解決後に汎用パターンを抽出し、
 * 類似問題の自動解決に活用する。
 */

import {
  LearnedPattern,
  ExtractionContext,
  PatternCondition,
  PatternSolution,
  determinePhase,
} from "./types.js";
import { patternRepository } from "./pattern-repository.js";
import { aiAnalyzer } from "./ai-analyzer.js";
import { logger } from "../core/logger.js";
import { Trouble } from "../trouble/types.js";

/**
 * 失敗パターン情報
 * 同じ失敗を避けるための参照データ
 */
export interface FailurePattern {
  id: string;
  troubleCategory: string;
  troubleMessage: string;
  troubleFile?: string;
  attemptedFixes: string[];
  failureReason: string;
  createdAt: string;
  occurrenceCount: number;
}

export class PatternExtractor {
  private failurePatterns: Map<string, FailurePattern> = new Map();

  /**
   * 解決結果からパターンを抽出
   */
  async extractPattern(context: ExtractionContext): Promise<LearnedPattern | null> {
    // 失敗した解決からはパターンを抽出しない
    if (!context.success) {
      logger.debug("Skipping pattern extraction for failed solution");
      return null;
    }

    // 変更が空の場合もスキップ
    if (!context.solution.changes || context.solution.changes.length === 0) {
      logger.debug("Skipping pattern extraction - no changes");
      return null;
    }

    try {
      // 問題のパターンを分析
      const conditions = await this.extractConditions(context);
      if (conditions.length === 0) {
        logger.debug("No conditions extracted");
        return null;
      }

      // 解決策のパターンを分析
      const solution = await this.extractSolution(context);
      if (!solution) {
        logger.debug("No solution pattern extracted");
        return null;
      }

      // パターンを生成
      const pattern = this.createPattern(
        context.problem.type,
        context.problem.description,
        conditions,
        solution
      );

      // 既存の類似パターンをチェック
      const similar = patternRepository.findSimilarPatterns(pattern.name);
      if (similar.length > 0) {
        logger.debug("Similar pattern already exists", {
          newPattern: pattern.name,
          existingPatterns: similar.map((p) => p.name),
        });

        // 統合を試みる
        const merged = await this.attemptMerge(pattern, similar[0]);
        if (merged) {
          return merged;
        }
      }

      logger.info("New pattern extracted", {
        id: pattern.id,
        name: pattern.name,
        conditions: conditions.length,
      });

      return pattern;
    } catch (error) {
      logger.error("Pattern extraction failed", { error });
      return null;
    }
  }

  /**
   * 問題から条件を抽出
   */
  private async extractConditions(context: ExtractionContext): Promise<PatternCondition[]> {
    const conditions: PatternCondition[] = [];
    const { problem } = context;

    // ファイルパターンを抽出
    if (problem.file) {
      const filePattern = this.generalizeFilePath(problem.file);
      if (filePattern) {
        conditions.push({
          type: "file-glob",
          value: filePattern,
          target: "filename",
        });
      }
    }

    // 問題の説明から正規表現パターンを抽出
    if (problem.content) {
      const regexPattern = await this.extractRegexPattern(
        problem.description,
        problem.content
      );
      if (regexPattern) {
        conditions.push({
          type: "regex",
          value: regexPattern,
          target: "content",
        });
      }
    }

    // エラーコードがあれば追加
    const errorCode = this.extractErrorCode(problem.description);
    if (errorCode) {
      conditions.push({
        type: "error-code",
        value: errorCode,
        target: "error-message",
      });
    }

    return conditions;
  }

  /**
   * 解決策を抽出
   */
  private async extractSolution(context: ExtractionContext): Promise<PatternSolution | null> {
    const { solution, problem } = context;

    // 単一ファイルの変更の場合、テンプレートを生成
    if (solution.changes.length === 1) {
      const change = solution.changes[0];
      const template = this.createTemplate(change.before, change.after, problem.description);

      if (template) {
        return {
          type: "template",
          content: template,
        };
      }
    }

    // 複数ファイルまたは複雑な変更の場合、AIプロンプトを生成
    return {
      type: "ai-prompt",
      content: `Fix: ${problem.description}\nApply similar changes as: ${solution.description}`,
    };
  }

  /**
   * ファイルパスを汎用化
   */
  private generalizeFilePath(filePath: string): string | null {
    // 特定のディレクトリパターンを抽出
    if (filePath.includes("/src/")) {
      const ext = filePath.split(".").pop();
      if (ext) {
        return `**/*.${ext}`;
      }
    }

    // テストファイル
    if (filePath.includes(".test.") || filePath.includes(".spec.")) {
      return "**/*.{test,spec}.*";
    }

    return null;
  }

  /**
   * 正規表現パターンを抽出
   */
  private async extractRegexPattern(
    description: string,
    content: string
  ): Promise<string | null> {
    // 共通パターンを検出
    const commonPatterns = [
      { keyword: "console.log", pattern: "console\\.(log|warn|error|debug)\\(" },
      { keyword: "unused import", pattern: "import\\s+\\{[^}]*\\}\\s+from" },
      { keyword: "any type", pattern: ":\\s*any\\b" },
      { keyword: "todo", pattern: "//\\s*(TODO|FIXME|HACK):" },
      { keyword: "empty catch", pattern: "catch\\s*\\([^)]*\\)\\s*\\{\\s*\\}" },
      { keyword: "magic number", pattern: "\\b\\d{4,}\\b" },
      { keyword: "long function", pattern: "function\\s+\\w+\\s*\\([^)]*\\)\\s*\\{" },
    ];

    const lowerDesc = description.toLowerCase();
    for (const { keyword, pattern } of commonPatterns) {
      if (lowerDesc.includes(keyword)) {
        return pattern;
      }
    }

    // AIを使用して汎用パターンを生成
    try {
      const verification = await aiAnalyzer.verifyPatternGeneralization(
        description,
        [content.substring(0, 500)]
      );

      if (verification.isGeneralizable && verification.suggestedPattern) {
        return verification.suggestedPattern;
      }
    } catch {
      // AI検証失敗
    }

    return null;
  }

  /**
   * エラーコードを抽出
   */
  private extractErrorCode(description: string): string | null {
    // TypeScriptエラーコード (TS1234)
    const tsMatch = description.match(/TS\d{4}/);
    if (tsMatch) return tsMatch[0];

    // ESLintルール
    const eslintMatch = description.match(/@typescript-eslint\/[\w-]+|[\w-]+\/[\w-]+/);
    if (eslintMatch) return eslintMatch[0];

    return null;
  }

  /**
   * 変更からテンプレートを作成
   */
  private createTemplate(before: string, after: string, description: string): string | null {
    // 変更が小さい場合のみテンプレート化
    if (before.length > 500 || after.length > 500) {
      return null;
    }

    // 変数部分を抽出（将来の拡張用）
    // 現時点では単純なテンプレートを返す
    return `Replace:\n${before}\n\nWith:\n${after}`;
  }

  /**
   * パターンを作成
   */
  private createPattern(
    problemType: string,
    description: string,
    conditions: PatternCondition[],
    solution: PatternSolution
  ): LearnedPattern {
    const id = `pattern_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
    const name = this.generatePatternName(problemType, description);
    const now = new Date().toISOString();

    return {
      id,
      name,
      version: 1,
      conditions,
      solution,
      stats: {
        usageCount: 0,
        successCount: 0,
        confidence: 0.9, // 初期信頼度
        lastUsed: now,
        phase: "initial",
      },
      history: [
        {
          version: 1,
          timestamp: now,
          changeReason: "Initial extraction from AI solution",
        },
      ],
      createdAt: now,
    };
  }

  /**
   * パターン名を生成
   */
  private generatePatternName(problemType: string, description: string): string {
    // 説明から主要なキーワードを抽出
    const keywords = description
      .toLowerCase()
      .replace(/[^a-z0-9\s]/g, "")
      .split(/\s+/)
      .filter((w) => w.length > 3)
      .slice(0, 3);

    if (keywords.length > 0) {
      return keywords.join("-");
    }

    return `${problemType}-fix-${Date.now() % 10000}`;
  }

  /**
   * 類似パターンとのマージを試みる
   */
  private async attemptMerge(
    newPattern: LearnedPattern,
    existing: LearnedPattern
  ): Promise<LearnedPattern | null> {
    // 条件がほぼ同じ場合のみマージ
    const conditionsSimilar = this.areConditionsSimilar(
      newPattern.conditions,
      existing.conditions
    );

    if (!conditionsSimilar) {
      return null;
    }

    // 既存パターンのバージョンを上げる
    patternRepository.upgradePatternVersion(existing.id, "Merged with new similar pattern");

    // 統計を更新（新しいパターンの情報を加味）
    const updated = patternRepository.getPattern(existing.id);
    if (updated) {
      logger.info("Pattern merged", {
        existingId: existing.id,
        newPatternName: newPattern.name,
      });
      return updated;
    }

    return null;
  }

  /**
   * 条件が類似しているかチェック
   */
  private areConditionsSimilar(
    conditionsA: PatternCondition[],
    conditionsB: PatternCondition[]
  ): boolean {
    if (conditionsA.length !== conditionsB.length) {
      return false;
    }

    for (const condA of conditionsA) {
      const hasMatch = conditionsB.some(
        (condB) =>
          condA.type === condB.type &&
          condA.target === condB.target &&
          this.isSimilarValue(condA.value, condB.value)
      );
      if (!hasMatch) {
        return false;
      }
    }

    return true;
  }

  /**
   * 値が類似しているかチェック
   */
  private isSimilarValue(valueA: string, valueB: string): boolean {
    // 完全一致
    if (valueA === valueB) return true;

    // 片方が他方を含む（より汎用的なパターン）
    if (valueA.includes(valueB) || valueB.includes(valueA)) return true;

    // 類似度計算（簡易版）
    const similarity = this.calculateSimilarity(valueA, valueB);
    return similarity > 0.8;
  }

  /**
   * 文字列の類似度を計算（簡易版）
   */
  private calculateSimilarity(a: string, b: string): number {
    const longer = a.length > b.length ? a : b;
    const shorter = a.length > b.length ? b : a;

    if (longer.length === 0) return 1.0;

    const editDistance = this.levenshteinDistance(longer, shorter);
    return (longer.length - editDistance) / longer.length;
  }

  /**
   * レーベンシュタイン距離を計算
   */
  private levenshteinDistance(a: string, b: string): number {
    const matrix: number[][] = [];

    for (let i = 0; i <= b.length; i++) {
      matrix[i] = [i];
    }

    for (let j = 0; j <= a.length; j++) {
      matrix[0][j] = j;
    }

    for (let i = 1; i <= b.length; i++) {
      for (let j = 1; j <= a.length; j++) {
        if (b.charAt(i - 1) === a.charAt(j - 1)) {
          matrix[i][j] = matrix[i - 1][j - 1];
        } else {
          matrix[i][j] = Math.min(
            matrix[i - 1][j - 1] + 1,
            matrix[i][j - 1] + 1,
            matrix[i - 1][j] + 1
          );
        }
      }
    }

    return matrix[b.length][a.length];
  }

  /**
   * 複数の抽出コンテキストから一括でパターンを抽出
   */
  async extractPatterns(contexts: ExtractionContext[]): Promise<LearnedPattern[]> {
    const patterns: LearnedPattern[] = [];

    for (const context of contexts) {
      const pattern = await this.extractPattern(context);
      if (pattern) {
        patterns.push(pattern);
      }
    }

    return patterns;
  }

  /**
   * 失敗から学習する
   * 同じ失敗を避けるためのパターンを記録
   */
  extractFromFailure(
    trouble: Trouble,
    attemptedFixes: string[],
    failureReason: string
  ): FailurePattern {
    // 既存の類似失敗パターンを検索
    const existingKey = this.findSimilarFailureKey(trouble);

    if (existingKey) {
      const existing = this.failurePatterns.get(existingKey)!;
      existing.occurrenceCount++;
      // 新しい試行を追加（重複は避ける）
      for (const fix of attemptedFixes) {
        if (!existing.attemptedFixes.includes(fix)) {
          existing.attemptedFixes.push(fix);
        }
      }
      logger.debug("Updated existing failure pattern", {
        id: existing.id,
        occurrenceCount: existing.occurrenceCount,
      });
      return existing;
    }

    // 新しい失敗パターンを作成
    const failurePattern: FailurePattern = {
      id: `failure_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`,
      troubleCategory: trouble.category,
      troubleMessage: trouble.message,
      troubleFile: trouble.file,
      attemptedFixes,
      failureReason,
      createdAt: new Date().toISOString(),
      occurrenceCount: 1,
    };

    this.failurePatterns.set(failurePattern.id, failurePattern);

    logger.info("New failure pattern recorded", {
      id: failurePattern.id,
      category: trouble.category,
      message: trouble.message.slice(0, 100),
    });

    return failurePattern;
  }

  /**
   * 類似の失敗パターンのキーを検索
   */
  private findSimilarFailureKey(trouble: Trouble): string | null {
    for (const [key, pattern] of this.failurePatterns) {
      if (
        pattern.troubleCategory === trouble.category &&
        pattern.troubleFile === trouble.file &&
        this.isSimilarMessage(pattern.troubleMessage, trouble.message)
      ) {
        return key;
      }
    }
    return null;
  }

  /**
   * メッセージが類似しているかチェック
   */
  private isSimilarMessage(a: string, b: string): boolean {
    // 完全一致
    if (a === b) return true;

    // 類似度計算
    const similarity = this.calculateSimilarity(a, b);
    return similarity > 0.7;
  }

  /**
   * 失敗パターンを取得（新しい修正を試みる前にチェック用）
   */
  getFailurePatterns(): FailurePattern[] {
    return Array.from(this.failurePatterns.values());
  }

  /**
   * 特定のトラブルに対して既に試行された修正を取得
   */
  getAttemptedFixes(trouble: Trouble): string[] {
    const key = this.findSimilarFailureKey(trouble);
    if (key) {
      const pattern = this.failurePatterns.get(key);
      return pattern?.attemptedFixes || [];
    }
    return [];
  }

  /**
   * 繰り返し失敗しているパターンを取得
   */
  getRepeatedFailures(minOccurrences: number = 3): FailurePattern[] {
    return Array.from(this.failurePatterns.values()).filter(
      (p) => p.occurrenceCount >= minOccurrences
    );
  }

  /**
   * 失敗パターンをクリア（テスト用）
   */
  clearFailurePatterns(): void {
    this.failurePatterns.clear();
  }
}

// シングルトンインスタンス
export const patternExtractor = new PatternExtractor();
