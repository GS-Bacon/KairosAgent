/**
 * AI Analyzer - AIフォールバック分析
 *
 * ルールエンジンでマッチしない場合にAIを使用して
 * コードを分析し、改善提案を生成する。
 */

import * as fs from "fs";
import * as path from "path";
import {
  AIImprovement,
  SemanticSearchResult,
  AnalyzeContext,
} from "./types.js";
import { getAIProvider } from "../ai/factory.js";
import { logger } from "../core/logger.js";
import { parseJSONObject } from "../ai/json-parser.js";

export class AIAnalyzer {
  /**
   * コードの改善点をAIで分析
   */
  async analyzeImprovements(
    files: string[],
    context: AnalyzeContext
  ): Promise<AIImprovement[]> {
    const improvements: AIImprovement[] = [];

    try {
      const provider = getAIProvider();
      const isAvailable = await provider.isAvailable();

      if (!isAvailable) {
        logger.warn("AI provider not available for analysis");
        return improvements;
      }

      // ファイルを分析
      for (const file of files) {
        if (!fs.existsSync(file)) continue;

        const content = fs.readFileSync(file, "utf-8");

        // ファイルが小さすぎる場合はスキップ
        if (content.length < 50) continue;

        try {
          const analysis = await provider.analyzeCode(content);

          for (const issue of analysis.issues) {
            if (issue.severity !== "low") {
              improvements.push({
                id: `ai_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`,
                type: this.mapIssueType(issue.type),
                description: issue.message,
                file,
                line: issue.line,
                priority: issue.severity,
                aiGenerated: true,
              });
            }
          }

          // サジェスチョンも改善として追加
          for (const suggestion of analysis.suggestions) {
            improvements.push({
              id: `ai_sug_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`,
              type: "optimization",
              description: suggestion,
              file,
              priority: "medium",
              aiGenerated: true,
            });
          }
        } catch (error) {
          logger.debug("Analysis failed for file", { file, error });
        }
      }
    } catch (error) {
      logger.error("AI analysis failed", { error });
    }

    return improvements;
  }

  /**
   * セマンティック検索を実行
   */
  async semanticSearch(
    query: string,
    files: string[]
  ): Promise<SemanticSearchResult[]> {
    const results: SemanticSearchResult[] = [];

    try {
      const provider = getAIProvider();
      const isAvailable = await provider.isAvailable();

      if (!isAvailable) {
        logger.warn("AI provider not available for semantic search");
        return results;
      }

      // ファイルコンテンツを収集
      const codebase: string[] = [];
      for (const file of files) {
        if (fs.existsSync(file)) {
          const content = fs.readFileSync(file, "utf-8");
          codebase.push(`// File: ${file}\n${content}`);
        }
      }

      const searchResult = await provider.searchAndAnalyze(query, codebase);

      for (const finding of searchResult.findings) {
        results.push({
          file: finding.file,
          content: finding.content,
          relevance: finding.relevance,
          matchType: "semantic",
          context: searchResult.analysis,
        });
      }
    } catch (error) {
      logger.error("Semantic search failed", { error });
    }

    return results;
  }

  /**
   * 問題に対する解決策をAIに提案させる
   */
  async suggestSolution(
    problem: {
      type: string;
      description: string;
      file: string;
      content?: string;
    }
  ): Promise<{
    suggestion: string;
    confidence: number;
    codeSnippet?: string;
  } | null> {
    try {
      const provider = getAIProvider();
      const isAvailable = await provider.isAvailable();

      if (!isAvailable) {
        return null;
      }

      const prompt = this.buildSolutionPrompt(problem);
      const response = await provider.chat(prompt);

      // レスポンスをパース
      const parsed = this.parseSolutionResponse(response);
      return parsed;
    } catch (error) {
      logger.error("AI solution suggestion failed", { error });
      return null;
    }
  }

  /**
   * パターンの汎用性をAIで検証
   */
  async verifyPatternGeneralization(
    specificPattern: string,
    examples: string[]
  ): Promise<{
    isGeneralizable: boolean;
    suggestedPattern?: string;
    confidence: number;
  }> {
    try {
      const provider = getAIProvider();
      const isAvailable = await provider.isAvailable();

      if (!isAvailable) {
        return { isGeneralizable: false, confidence: 0 };
      }

      const prompt = `
Analyze if the following pattern can be generalized for reuse:

Pattern: ${specificPattern}

Examples where this pattern might apply:
${examples.map((e, i) => `${i + 1}. ${e}`).join("\n")}

Please respond in JSON format:
{
  "isGeneralizable": true/false,
  "suggestedPattern": "generalized regex or pattern",
  "confidence": 0.0-1.0,
  "reason": "explanation"
}
`;

      const response = await provider.chat(prompt);

      const parsed = parseJSONObject<{
        isGeneralizable?: boolean;
        suggestedPattern?: string;
        confidence?: number;
      }>(response);

      if (parsed) {
        return {
          isGeneralizable: parsed.isGeneralizable || false,
          suggestedPattern: parsed.suggestedPattern,
          confidence: parsed.confidence || 0,
        };
      }

      return { isGeneralizable: false, confidence: 0 };
    } catch (error) {
      logger.error("Pattern verification failed", { error });
      return { isGeneralizable: false, confidence: 0 };
    }
  }

  /**
   * 問題タイプをマッピング
   */
  private mapIssueType(
    type: string
  ): "refactor" | "optimization" | "security" | "bug-fix" | "style" {
    const lowerType = type.toLowerCase();

    if (lowerType.includes("security") || lowerType.includes("vulnerability")) {
      return "security";
    }
    if (lowerType.includes("bug") || lowerType.includes("error")) {
      return "bug-fix";
    }
    if (lowerType.includes("performance") || lowerType.includes("optimize")) {
      return "optimization";
    }
    if (lowerType.includes("style") || lowerType.includes("format")) {
      return "style";
    }
    return "refactor";
  }

  /**
   * 解決策プロンプトを構築
   */
  private buildSolutionPrompt(problem: {
    type: string;
    description: string;
    file: string;
    content?: string;
  }): string {
    let prompt = `
Analyze the following problem and suggest a solution:

Problem Type: ${problem.type}
Description: ${problem.description}
File: ${problem.file}
`;

    if (problem.content) {
      prompt += `
Code Context:
\`\`\`
${problem.content.substring(0, 2000)}
\`\`\`
`;
    }

    prompt += `
Please provide:
1. A brief explanation of the solution
2. A code snippet if applicable
3. Your confidence level (0-1)

Respond in JSON format:
{
  "suggestion": "explanation",
  "codeSnippet": "code if applicable",
  "confidence": 0.0-1.0
}
`;

    return prompt;
  }

  /**
   * 解決策レスポンスをパース
   */
  private parseSolutionResponse(response: string): {
    suggestion: string;
    confidence: number;
    codeSnippet?: string;
  } | null {
    const parsed = parseJSONObject<{
      suggestion?: string;
      confidence?: number;
      codeSnippet?: string;
    }>(response);

    if (parsed) {
      return {
        suggestion: parsed.suggestion || "",
        confidence: parsed.confidence || 0.5,
        codeSnippet: parsed.codeSnippet,
      };
    }

    // フォールバック: プレーンテキストとして扱う
    return {
      suggestion: response.substring(0, 500),
      confidence: 0.3,
    };
  }
}

// シングルトンインスタンス
export const aiAnalyzer = new AIAnalyzer();
