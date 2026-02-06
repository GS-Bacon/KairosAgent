/**
 * AI Summarizer Service
 *
 * サイクルログとデイリーレポートのAI要約を生成
 * 失敗原因の分析と次のアクションの推奨を提供
 */

import { logger } from "../core/logger.js";
import { getAIProvider } from "./factory.js";
import { parseJSONObject } from "./json-parser.js";

/**
 * サイクル要約の入力データ
 */
export interface CycleSummaryInput {
  cycleId: string;
  success: boolean;
  duration: number;
  failedPhase?: string;
  failureReason?: string;
  issues: Array<{
    type: string;
    message: string;
    file?: string;
    resolved?: boolean;
  }>;
  changes: Array<{
    file: string;
    changeType: string;
    summary?: string;
  }>;
  troubles: Array<{
    type: string;
    message: string;
  }>;
}

/**
 * サイクル要約の出力
 */
export interface CycleSummary {
  status: string;           // "成功" or "失敗 - ○○が原因"
  whatHappened: string;     // 2-3文で何が起きたか
  recommendation?: string;  // 次のアクション（失敗時のみ）
}

/**
 * デイリー要約の出力
 */
export interface DailySummary {
  overallStatus: string;
  mainIssues: string[];
  trendAnalysis: string;
  recommendations: string[];
}

/**
 * デイリーレポートの統計データ
 */
export interface DailyStats {
  cyclesExecuted: number;
  successRate: number;
  troublesEncountered: number;
  totalTokenInput: number;
  totalTokenOutput: number;
}

/**
 * AI要約サービス
 */
export class AISummarizer {
  /**
   * サイクルの要約を生成
   */
  async summarizeCycle(input: CycleSummaryInput): Promise<CycleSummary | null> {
    try {
      const provider = getAIProvider();

      // 入力データを簡潔に整形
      const issuesSummary = input.issues.length > 0
        ? input.issues.slice(0, 5).map(i =>
            `- [${i.type}] ${i.message.slice(0, 100)}${i.file ? ` @ ${i.file}` : ""}`
          ).join("\n")
        : "なし";

      const changesSummary = input.changes.length > 0
        ? input.changes.slice(0, 5).map(c =>
            `- ${c.file} (${c.changeType})${c.summary ? `: ${c.summary.slice(0, 50)}` : ""}`
          ).join("\n")
        : "なし";

      const troublesSummary = input.troubles.length > 0
        ? input.troubles.slice(0, 5).map(t =>
            `- [${t.type}] ${t.message.slice(0, 100)}`
          ).join("\n")
        : "なし";

      const prompt = `サイクル結果を日本語で簡潔に要約してください。JSONで返してください。

サイクルID: ${input.cycleId}
結果: ${input.success ? "成功" : "失敗"}
所要時間: ${(input.duration / 1000).toFixed(1)}秒
${input.failedPhase ? `失敗フェーズ: ${input.failedPhase}` : ""}
${input.failureReason ? `失敗理由: ${input.failureReason}` : ""}

検出された問題:
${issuesSummary}

実行された変更:
${changesSummary}

発生したトラブル:
${troublesSummary}

出力形式（JSON）:
{
  "status": "成功" または "失敗 - [原因]",
  "whatHappened": "何が起きたかを2-3文で",
  "recommendation": "次に何をすべきか（失敗時のみ）"
}`;

      const response = await provider.chat(prompt);

      // JSONを抽出
      const parsed = parseJSONObject<CycleSummary>(response);
      if (parsed) {
        return parsed;
      }

      logger.warn("Failed to parse cycle summary JSON", { response: response.slice(0, 200) });
      return null;
    } catch (error) {
      logger.warn("Failed to generate cycle summary", {
        error: error instanceof Error ? error.message : String(error),
      });
      return null;
    }
  }

  /**
   * デイリーレポートの要約を生成
   */
  async summarizeDaily(
    cycleSummaries: CycleSummary[],
    stats: DailyStats
  ): Promise<DailySummary | null> {
    try {
      const provider = getAIProvider();

      // サイクル要約を整形
      const summariesText = cycleSummaries.length > 0
        ? cycleSummaries.slice(0, 10).map((s, i) =>
            `${i + 1}. ${s.status}: ${s.whatHappened.slice(0, 100)}`
          ).join("\n")
        : "要約なし";

      const prompt = `1日のサイクル実行結果を分析し、日本語で要約してください。JSONで返してください。

統計:
- 実行サイクル数: ${stats.cyclesExecuted}
- 成功率: ${stats.successRate.toFixed(1)}%
- トラブル数: ${stats.troublesEncountered}
- 使用トークン: 入力${stats.totalTokenInput.toLocaleString()}, 出力${stats.totalTokenOutput.toLocaleString()}

サイクル要約:
${summariesText}

出力形式（JSON）:
{
  "overallStatus": "全体の状況を1文で",
  "mainIssues": ["主要な問題1", "主要な問題2"],
  "trendAnalysis": "傾向分析を2-3文で",
  "recommendations": ["推奨アクション1", "推奨アクション2"]
}`;

      const response = await provider.chat(prompt);

      // JSONを抽出
      const parsed = parseJSONObject<DailySummary>(response);
      if (parsed) {
        return parsed;
      }

      logger.warn("Failed to parse daily summary JSON", { response: response.slice(0, 200) });
      return null;
    } catch (error) {
      logger.warn("Failed to generate daily summary", {
        error: error instanceof Error ? error.message : String(error),
      });
      return null;
    }
  }

  /**
   * 簡易的なフォールバック要約を生成（AI呼び出し失敗時）
   */
  generateFallbackCycleSummary(input: CycleSummaryInput): CycleSummary {
    if (input.success) {
      return {
        status: "成功",
        whatHappened: `${input.changes.length}件の変更を実行。${input.issues.length}件の問題を処理。`,
      };
    }

    const troubleTypes = input.troubles.map(t => t.type).filter((v, i, a) => a.indexOf(v) === i);
    const failureInfo = input.failedPhase
      ? `${input.failedPhase}フェーズで失敗`
      : "処理中に失敗";

    return {
      status: `失敗 - ${failureInfo}`,
      whatHappened: input.failureReason
        ? input.failureReason.slice(0, 200)
        : troubleTypes.length > 0
          ? `トラブル発生: ${troubleTypes.join(", ")}`
          : "詳細不明",
      recommendation: input.troubles.length > 0
        ? `${input.troubles[0].message.slice(0, 100)}を確認`
        : undefined,
    };
  }

  /**
   * 簡易的なフォールバックデイリー要約を生成（AI呼び出し失敗時）
   */
  generateFallbackDailySummary(stats: DailyStats): DailySummary {
    const status = stats.successRate >= 80
      ? "良好"
      : stats.successRate >= 50
        ? "要注意"
        : "問題あり";

    return {
      overallStatus: `${stats.cyclesExecuted}サイクル実行、成功率${stats.successRate.toFixed(1)}%（${status}）`,
      mainIssues: stats.troublesEncountered > 0
        ? [`${stats.troublesEncountered}件のトラブルが発生`]
        : [],
      trendAnalysis: `トークン使用量: 入力${stats.totalTokenInput.toLocaleString()}, 出力${stats.totalTokenOutput.toLocaleString()}`,
      recommendations: stats.successRate < 50
        ? ["失敗パターンの分析が必要", "トラブルログの確認を推奨"]
        : [],
    };
  }
}

export const aiSummarizer = new AISummarizer();
