import { Phase, PhaseResult, CycleContext, Improvement } from "../types.js";
import { CodeSearcher } from "./searcher.js";
import { SearchQuery, SearchAnalysis } from "./types.js";
import { logger } from "../../core/logger.js";
import {
  ruleEngine,
  aiAnalyzer,
  PatternMatch,
  SemanticSearchResult,
} from "../../learning/index.js";

export class SearchPhase implements Phase {
  name = "search";
  private searcher: CodeSearcher;

  constructor() {
    this.searcher = new CodeSearcher();
  }

  async execute(context: CycleContext): Promise<PhaseResult> {
    if (context.issues.length === 0 && context.improvements.length === 0) {
      return {
        success: true,
        shouldStop: true,
        message: "No issues or improvements to search for",
      };
    }

    logger.debug("Searching for related code");

    // Prioritize issues over improvements
    const issue = context.issues[0];
    const improvement = context.improvements[0];
    const isIssue = !!issue;
    const targetFile = isIssue ? issue.file : improvement.file;
    const targetText = isIssue ? issue.message : improvement.description;

    const query: SearchQuery = {
      target: targetText,
      type: isIssue ? "error" : "improvement",
      context: targetFile,
    };

    // 1. パターンベース検索（類似問題の解決策を参照）
    let patternResults: PatternMatch[] = [];
    try {
      await ruleEngine.initialize();
      patternResults = ruleEngine.findSimilarSolutions([
        {
          message: isIssue ? issue.message : undefined,
          description: isIssue ? undefined : improvement.description,
        },
      ]);

      if (patternResults.length > 0) {
        logger.info("Found similar patterns", { count: patternResults.length });

        // 使用したパターンを記録
        for (const match of patternResults) {
          if (context.usedPatterns && !context.usedPatterns.includes(match.patternId)) {
            context.usedPatterns.push(match.patternId);
          }
        }
      }
    } catch (error) {
      logger.debug("Pattern search failed, continuing with keyword search", { error });
    }

    // 2. キーワード検索（既存）
    const analysis = await this.searcher.search(query);

    // If we have a specific file, also get its dependencies
    if (targetFile) {
      const deps = await this.searcher.findDependencies(targetFile);
      for (const dep of deps) {
        if (!analysis.relatedFiles.includes(dep)) {
          analysis.relatedFiles.push(dep);
        }
      }
    }

    // 3. 必要に応じてAIセマンティック検索
    let semanticResults: SemanticSearchResult[] = [];
    const needsAI = analysis.findings.length < 3 && patternResults.length === 0;

    if (needsAI) {
      try {
        const sourceFiles = this.getSourceFiles();
        semanticResults = await aiAnalyzer.semanticSearch(query.target, sourceFiles);

        if (semanticResults.length > 0) {
          logger.info("Semantic search completed", { results: semanticResults.length });
          context.aiCalls = (context.aiCalls || 0) + 1;
        }
      } catch (error) {
        logger.debug("Semantic search failed", { error });
      }
    }

    // 結果をマージ
    const mergedFindings = this.mergeResults(analysis, patternResults, semanticResults);

    context.searchResults = {
      query: query.target,
      findings: mergedFindings.map((f) => ({
        file: f.file,
        content: f.content,
        relevance: f.relevance,
      })),
      analysis: this.generateAnalysisSummary(analysis, patternResults, semanticResults),
    };

    logger.info("Search completed", {
      keywordFindings: analysis.findings.length,
      patternMatches: patternResults.length,
      semanticResults: semanticResults.length,
      totalFindings: context.searchResults.findings.length,
      relatedFiles: analysis.relatedFiles.length,
    });

    return {
      success: true,
      shouldStop: false,
      message: `Found ${context.searchResults.findings.length} related code sections`,
      data: {
        ...analysis,
        patternMatches: patternResults.length,
        semanticResults: semanticResults.length,
      },
    };
  }

  /**
   * 検索結果をマージ
   */
  private mergeResults(
    keywordAnalysis: SearchAnalysis,
    patternResults: PatternMatch[],
    semanticResults: SemanticSearchResult[]
  ): Array<{ file: string; content: string; relevance: number; source: string }> {
    const merged: Array<{ file: string; content: string; relevance: number; source: string }> = [];
    const seen = new Set<string>();

    // パターン結果を追加（高優先度）
    for (const match of patternResults) {
      const key = `${match.file}:${match.matchedContent.substring(0, 50)}`;
      if (!seen.has(key)) {
        seen.add(key);
        merged.push({
          file: match.file,
          content: match.suggestedFix || match.matchedContent,
          relevance: match.confidence * 1.5, // パターン結果は重み付け
          source: "pattern",
        });
      }
    }

    // セマンティック検索結果を追加
    for (const result of semanticResults) {
      const key = `${result.file}:${result.content.substring(0, 50)}`;
      if (!seen.has(key)) {
        seen.add(key);
        merged.push({
          file: result.file,
          content: result.content,
          relevance: result.relevance * 1.2, // セマンティック結果も重み付け
          source: "semantic",
        });
      }
    }

    // キーワード検索結果を追加
    for (const finding of keywordAnalysis.findings) {
      const key = `${finding.file}:${finding.content.substring(0, 50)}`;
      if (!seen.has(key)) {
        seen.add(key);
        merged.push({
          file: finding.file,
          content: finding.content,
          relevance: finding.relevance,
          source: "keyword",
        });
      }
    }

    // 関連性でソートして上位20件を返す
    return merged.sort((a, b) => b.relevance - a.relevance).slice(0, 20);
  }

  /**
   * 分析サマリーを生成
   */
  private generateAnalysisSummary(
    keywordAnalysis: SearchAnalysis,
    patternResults: PatternMatch[],
    semanticResults: SemanticSearchResult[]
  ): string {
    const parts: string[] = [];

    if (patternResults.length > 0) {
      parts.push(
        `Found ${patternResults.length} similar pattern(s): ${patternResults.map((p) => p.patternName).join(", ")}`
      );
    }

    if (semanticResults.length > 0) {
      parts.push(`AI semantic search found ${semanticResults.length} relevant sections`);
    }

    if (keywordAnalysis.findings.length > 0) {
      parts.push(
        `Keyword search found ${keywordAnalysis.findings.length} matches in ${keywordAnalysis.relatedFiles.length} files`
      );
    }

    if (keywordAnalysis.summary) {
      parts.push(keywordAnalysis.summary);
    }

    return parts.join(". ") || "No significant findings";
  }

  /**
   * ソースファイルを収集
   */
  private getSourceFiles(): string[] {
    const fs = require("fs");
    const path = require("path");
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
}

export { CodeSearcher } from "./searcher.js";
export * from "./types.js";
