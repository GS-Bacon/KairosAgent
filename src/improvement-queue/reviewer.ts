/**
 * Improvement Reviewer - AIレビューによる実装判断ゲート
 *
 * キューから取得した改善提案を実装前にAIでレビューし、
 * 実装すべきかどうかを判断する
 */

import { getAIProvider } from "../ai/factory.js";
import { QueuedImprovement } from "./types.js";
import { logger } from "../core/logger.js";
import { parseJSONObject } from "../ai/json-parser.js";

export interface ReviewResult {
  approved: boolean;
  reason: string;
  suggestedPriority?: number;
  concerns?: string[];
}

export class ImprovementReviewer {
  /**
   * 改善提案をAIでレビューし、実装すべきか判断
   */
  async review(improvement: QueuedImprovement): Promise<ReviewResult> {
    const ai = getAIProvider();

    const prompt = `以下の改善提案を評価し、今実装すべきかどうか判断してください。

## 改善提案
タイトル: ${improvement.title}
説明: ${improvement.description}
優先度: ${improvement.priority}/100
ソース: ${improvement.source}
${improvement.metadata?.pros ? `メリット: ${(improvement.metadata.pros as string[]).join(", ")}` : ""}
${improvement.metadata?.cons ? `デメリット: ${(improvement.metadata.cons as string[]).join(", ")}` : ""}

## 評価基準
1. 実装リスク: 既存機能を壊す可能性はあるか
2. 効果の確実性: 提案の効果は検証可能か
3. 実装コスト vs 効果: 投資対効果は妥当か
4. 依存関係: 他の作業に依存していないか
5. 緊急性: 今すぐ必要か、後でも良いか

## 回答形式（JSON）
必ず以下のJSON形式で出力してください。JSON以外のテキストは含めないでください。

{
  "approved": true/false,
  "reason": "判断理由を簡潔に",
  "concerns": ["懸念点があれば列挙"],
  "suggestedPriority": 0-100（現在の優先度を調整する場合）
}`;

    try {
      const response = await ai.chat(prompt);

      // JSON部分を抽出
      const parsed = parseJSONObject<{
        approved?: boolean;
        reason?: string;
        concerns?: string[];
        suggestedPriority?: number;
      }>(response);

      if (parsed) {
        return {
          approved: parsed.approved ?? false,
          reason: parsed.reason ?? "No reason provided",
          concerns: Array.isArray(parsed.concerns) ? parsed.concerns : undefined,
          suggestedPriority:
            typeof parsed.suggestedPriority === "number" ? parsed.suggestedPriority : undefined,
        };
      }

      logger.warn("AI review response did not contain valid JSON", { response: response.substring(0, 200) });
      return { approved: false, reason: "Failed to parse AI response" };
    } catch (error) {
      logger.warn("AI review failed, defaulting to not approved", {
        error: error instanceof Error ? error.message : String(error),
      });
      return { approved: false, reason: "Review failed due to error" };
    }
  }

  /**
   * 複数の改善提案をバッチレビュー
   * 効率的にまとめてレビューする（オプション）
   */
  async batchReview(
    improvements: QueuedImprovement[]
  ): Promise<Map<string, ReviewResult>> {
    const results = new Map<string, ReviewResult>();

    // 並列実行で効率化（最大3件同時）
    const batchSize = 3;
    for (let i = 0; i < improvements.length; i += batchSize) {
      const batch = improvements.slice(i, i + batchSize);
      const reviews = await Promise.all(batch.map((imp) => this.review(imp)));

      for (let j = 0; j < batch.length; j++) {
        results.set(batch[j].id, reviews[j]);
      }
    }

    return results;
  }
}

export const improvementReviewer = new ImprovementReviewer();
