import { existsSync, readFileSync } from "fs";
import { Goal } from "../../goals/types.js";
import { Improvement } from "../types.js";
import { logger } from "../../core/logger.js";

export interface GoalImprovement {
  goalId: string;
  goalTitle: string;
  improvement: Improvement;
}

interface TokenOptimizationOpportunity {
  file: string;
  line: number;
  pattern: string;
  description: string;
  severity: "low" | "medium" | "high";
}

export class GoalBasedAnalyzer {
  /**
   * アクティブ目標から改善ポイントを検出
   */
  analyzeForGoals(goals: Goal[], files: string[]): GoalImprovement[] {
    const improvements: GoalImprovement[] = [];

    for (const goal of goals) {
      if (!goal.active) continue;

      // トークン最適化目標の検出
      if (this.isTokenOptimizationGoal(goal)) {
        const tokenImprovements = this.findTokenOptimizationOpportunities(files);
        for (const opp of tokenImprovements) {
          improvements.push({
            goalId: goal.id,
            goalTitle: goal.title,
            improvement: {
              id: `goal_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`,
              type: "optimization",
              description: `[Goal: ${goal.title}] ${opp.description}`,
              file: opp.file,
              line: opp.line,
              priority: opp.severity,
            },
          });
        }
      }
    }

    return improvements;
  }

  /**
   * トークン最適化目標かどうかを判定
   */
  private isTokenOptimizationGoal(goal: Goal): boolean {
    const keywords = ["トークン", "token", "最適化", "optimization", "削減"];
    const titleLower = goal.title.toLowerCase();
    const descLower = goal.description.toLowerCase();
    return keywords.some((kw) => titleLower.includes(kw) || descLower.includes(kw));
  }

  /**
   * トークン削減の改善機会を検出
   */
  findTokenOptimizationOpportunities(files: string[]): TokenOptimizationOpportunity[] {
    const opportunities: TokenOptimizationOpportunity[] = [];

    // 検出パターン
    const patterns = [
      {
        // existingCodeの全文送信パターン
        regex: /existingCode\s*[=:]\s*(?:readFileSync|fs\.readFileSync|content|fileContent)/g,
        pattern: "existingCode-full-send",
        description: "existingCodeにファイル全文を送信している可能性があります。エラー周辺行のみ抽出することでトークン削減可能",
        severity: "high" as const,
      },
      {
        // 大きなプロンプト構築パターン
        regex: /buildPrompt|createPrompt|generatePrompt/g,
        pattern: "prompt-builder",
        description: "プロンプト構築箇所。コンテキストサイズの最適化が可能か確認が必要",
        severity: "medium" as const,
      },
      {
        // テンプレートリテラルでの大きなコード埋め込み
        regex: /`[^`]*\$\{(?:code|content|source|fileContent|existingCode)[^`]*`/g,
        pattern: "template-code-embed",
        description: "テンプレートリテラルにコード全文を埋め込んでいる可能性があります",
        severity: "medium" as const,
      },
      {
        // JSON.stringifyでの大きなオブジェクト送信
        regex: /JSON\.stringify\s*\(\s*(?:context|codeContext|fileData)/g,
        pattern: "json-context-serialize",
        description: "大きなコンテキストオブジェクトをJSON化している可能性があります",
        severity: "medium" as const,
      },
    ];

    for (const file of files) {
      if (!existsSync(file)) continue;

      // 小さなファイル（100行未満）はスキップ（品質優先）
      try {
        const content = readFileSync(file, "utf-8");
        const lines = content.split("\n");

        if (lines.length < 100) continue;

        for (const patternDef of patterns) {
          patternDef.regex.lastIndex = 0;
          let match;

          while ((match = patternDef.regex.exec(content)) !== null) {
            // マッチした位置から行番号を計算
            const lineNumber = content.substring(0, match.index).split("\n").length;

            // 重複チェック
            const isDuplicate = opportunities.some(
              (opp) => opp.file === file && opp.line === lineNumber && opp.pattern === patternDef.pattern
            );

            if (!isDuplicate) {
              opportunities.push({
                file,
                line: lineNumber,
                pattern: patternDef.pattern,
                description: patternDef.description,
                severity: patternDef.severity,
              });
            }
          }
        }

        // 追加チェック: 非常に長い関数でAI呼び出しを含む箇所
        this.checkLongFunctionsWithAICalls(content, file, lines, opportunities);
      } catch (err) {
        logger.warn(`Failed to analyze file for token optimization: ${file}`);
      }
    }

    logger.debug("Token optimization opportunities found", { count: opportunities.length });
    return opportunities;
  }

  /**
   * AI呼び出しを含む長い関数を検出
   */
  private checkLongFunctionsWithAICalls(
    content: string,
    file: string,
    lines: string[],
    opportunities: TokenOptimizationOpportunity[]
  ): void {
    // AI呼び出しパターン
    const aiCallPatterns = [
      /aiProvider\.(?:complete|chat|generate)/,
      /claude\.(?:complete|messages)/,
      /openai\.(?:chat|completions)/,
      /callAI|invokeAI|generateWithAI/,
    ];

    // 関数開始を検出
    let braceDepth = 0;
    let functionStart = -1;
    let functionName = "";

    for (let i = 0; i < lines.length; i++) {
      const line = lines[i];

      // 関数定義の検出
      const funcMatch = line.match(/(?:async\s+)?(?:function\s+(\w+)|(\w+)\s*=\s*(?:async\s*)?\([^)]*\)\s*=>|(\w+)\s*\([^)]*\)\s*[:{])/);
      if (funcMatch) {
        functionStart = i;
        functionName = funcMatch[1] || funcMatch[2] || funcMatch[3] || "anonymous";
      }

      braceDepth += (line.match(/{/g) || []).length;
      braceDepth -= (line.match(/}/g) || []).length;

      // 関数終了時にチェック
      if (functionStart >= 0 && braceDepth === 0 && i > functionStart) {
        const functionLength = i - functionStart;

        // 50行以上の関数でAI呼び出しを含む場合
        if (functionLength > 50) {
          const functionContent = lines.slice(functionStart, i + 1).join("\n");
          const hasAICall = aiCallPatterns.some((p) => p.test(functionContent));

          if (hasAICall) {
            const isDuplicate = opportunities.some(
              (opp) => opp.file === file && opp.line === functionStart + 1
            );

            if (!isDuplicate) {
              opportunities.push({
                file,
                line: functionStart + 1,
                pattern: "long-function-with-ai",
                description: `関数 ${functionName} (${functionLength}行) にAI呼び出しが含まれています。コンテキスト構築の最適化を検討してください`,
                severity: functionLength > 100 ? "high" : "medium",
              });
            }
          }
        }

        functionStart = -1;
      }
    }
  }
}
