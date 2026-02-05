/**
 * Pattern Abstractor
 *
 * 類似トラブルをグルーピングし、パターンを抽出する
 */

import { Trouble } from "../trouble/types.js";
import {
  TroublePattern,
  PatternMatchResult,
  PreventionSuggestion,
} from "./types.js";

export class PatternAbstractor {
  private readonly SIMILARITY_THRESHOLD = 0.5;

  /**
   * トラブルが既存のパターンにマッチするか確認
   */
  matchToExistingPatterns(
    trouble: Trouble,
    patterns: TroublePattern[]
  ): PatternMatchResult | null {
    let bestMatch: PatternMatchResult | null = null;
    let bestScore = 0;

    for (const pattern of patterns) {
      // カテゴリが一致しない場合はスキップ
      if (pattern.category !== trouble.category) continue;

      const { score, matchedKeywords } = this.calculateMatchScore(
        trouble,
        pattern
      );

      if (score > this.SIMILARITY_THRESHOLD && score > bestScore) {
        bestScore = score;
        bestMatch = {
          pattern,
          trouble,
          confidence: score,
          matchedKeywords,
        };
      }
    }

    return bestMatch;
  }

  /**
   * 複数のトラブルから新しいパターンを抽出
   */
  extractNewPattern(troubles: Trouble[]): TroublePattern | null {
    if (troubles.length < 2) return null;

    // 共通カテゴリを確認
    const categories = new Set(troubles.map((t) => t.category));
    if (categories.size !== 1) return null;

    const category = troubles[0].category;

    // 共通キーワードを抽出
    const keywordSets = troubles.map((t) => this.extractKeywords(t.message));
    const commonKeywords = this.findCommonKeywords(keywordSets);

    if (commonKeywords.length === 0) return null;

    // パターン名を生成
    const patternName = this.generatePatternName(category, commonKeywords);

    const now = new Date().toISOString();
    return {
      id: `pattern_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`,
      name: patternName,
      description: this.generateDescription(troubles, commonKeywords),
      category,
      keywords: commonKeywords,
      occurrenceCount: troubles.length,
      troubleIds: troubles.map((t) => t.id),
      preventionSuggestions: [],
      confidence: 0.5, // 初期信頼度
      createdAt: now,
      updatedAt: now,
      lastOccurredAt: now,
    };
  }

  /**
   * 類似トラブルをグルーピング
   */
  groupSimilarTroubles(troubles: Trouble[]): Trouble[][] {
    const groups: Trouble[][] = [];
    const assigned = new Set<string>();

    for (const trouble of troubles) {
      if (assigned.has(trouble.id)) continue;

      const group = [trouble];
      assigned.add(trouble.id);

      for (const other of troubles) {
        if (assigned.has(other.id)) continue;
        if (trouble.category !== other.category) continue;

        const similarity = this.calculateTextSimilarity(
          trouble.message,
          other.message
        );

        if (similarity > this.SIMILARITY_THRESHOLD) {
          group.push(other);
          assigned.add(other.id);
        }
      }

      groups.push(group);
    }

    return groups;
  }

  private calculateMatchScore(
    trouble: Trouble,
    pattern: TroublePattern
  ): { score: number; matchedKeywords: string[] } {
    const troubleKeywords = this.extractKeywords(trouble.message);
    const matchedKeywords = pattern.keywords.filter((k) =>
      troubleKeywords.some(
        (tk) => tk.includes(k.toLowerCase()) || k.toLowerCase().includes(tk)
      )
    );

    // キーワードマッチスコア
    const keywordScore =
      pattern.keywords.length > 0
        ? matchedKeywords.length / pattern.keywords.length
        : 0;

    // 正規表現マッチ
    let regexScore = 0;
    if (pattern.regex) {
      try {
        const regex = new RegExp(pattern.regex, "i");
        if (regex.test(trouble.message)) {
          regexScore = 1;
        }
      } catch {
        // Invalid regex, ignore
      }
    }

    // 重み付け平均
    const score = regexScore > 0 ? regexScore * 0.7 + keywordScore * 0.3 : keywordScore;

    return { score, matchedKeywords };
  }

  private extractKeywords(text: string): string[] {
    // 意味のある単語を抽出
    const words = text
      .toLowerCase()
      .replace(/[^\w\s-]/g, " ")
      .split(/\s+/)
      .filter((w) => w.length > 2);

    // ストップワードを除去
    const stopWords = new Set([
      "the",
      "and",
      "for",
      "are",
      "but",
      "not",
      "you",
      "all",
      "can",
      "had",
      "her",
      "was",
      "one",
      "our",
      "out",
      "has",
      "have",
      "been",
      "this",
      "that",
      "with",
      "from",
      "error",
      "failed",
      "cannot",
    ]);

    return words.filter((w) => !stopWords.has(w));
  }

  private findCommonKeywords(keywordSets: string[][]): string[] {
    if (keywordSets.length === 0) return [];
    if (keywordSets.length === 1) return keywordSets[0];

    const commonWords: string[] = [];
    const firstSet = keywordSets[0];

    for (const keyword of firstSet) {
      const inAll = keywordSets.every((set) =>
        set.some(
          (k) => k.includes(keyword) || keyword.includes(k) || k === keyword
        )
      );
      if (inAll) {
        commonWords.push(keyword);
      }
    }

    return commonWords;
  }

  private calculateTextSimilarity(a: string, b: string): number {
    const wordsA = new Set(this.extractKeywords(a));
    const wordsB = new Set(this.extractKeywords(b));

    const intersection = [...wordsA].filter((w) => wordsB.has(w)).length;
    const union = new Set([...wordsA, ...wordsB]).size;

    return union > 0 ? intersection / union : 0;
  }

  private generatePatternName(
    category: string,
    keywords: string[]
  ): string {
    const topKeywords = keywords.slice(0, 3).join("-");
    return `${category}-${topKeywords || "general"}`;
  }

  private generateDescription(
    troubles: Trouble[],
    keywords: string[]
  ): string {
    const category = troubles[0].category;
    const keywordList = keywords.slice(0, 5).join(", ");

    return `${category}に関連する問題パターン。キーワード: ${keywordList}。${troubles.length}件の類似トラブルから抽出。`;
  }
}

export const patternAbstractor = new PatternAbstractor();
