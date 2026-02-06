/**
 * Research機能 - ClaudeCodeを使用した攻めの改善
 *
 * アクティブ目標から調査テーマを抽出し、Web検索を含むプロンプトで調査を実行
 * 有望なアプローチをimprovementQueueに登録
 */

import { ClaudeProvider } from "../ai/claude-provider.js";
import { logger } from "../core/logger.js";
import { Goal } from "../goals/types.js";
import { improvementQueue } from "../improvement-queue/index.js";
import { parseJSONObject } from "../ai/json-parser.js";
import {
  ResearchTopic,
  ResearchResult,
  ResearchFinding,
  Approach,
  ResearchContext,
  ResearchAIResponse,
} from "./types.js";

export class Researcher {
  private claude: ClaudeProvider;

  constructor(claude?: ClaudeProvider) {
    this.claude = claude || new ClaudeProvider({ planModel: "opus" });
  }

  /**
   * アクティブ目標から調査トピックを抽出
   */
  extractTopics(goals: Goal[]): ResearchTopic[] {
    const topics: ResearchTopic[] = [];

    for (const goal of goals) {
      // アクティブな目標を調査対象に
      if (goal.active) {
        topics.push({
          id: `topic_${goal.id}_${Date.now()}`,
          topic: this.generateTopicFromGoal(goal),
          source: "goal",
          priority: this.calculatePriority(goal),
          relatedGoalId: goal.id,
          context: goal.description,
        });
      }
    }

    // 優先度順にソート
    return topics.sort((a, b) => b.priority - a.priority);
  }

  /**
   * 目標からトピックを生成
   */
  private generateTopicFromGoal(goal: Goal): string {
    // 目標タイトルと説明から調査テーマを生成
    const keywords = this.extractKeywords(goal.title, goal.description);
    return `${goal.title}の最適な実装方法と最新のベストプラクティス（${keywords.join(", ")}）`;
  }

  /**
   * キーワードを抽出
   */
  private extractKeywords(title: string, description: string): string[] {
    const text = `${title} ${description}`;
    // 技術的なキーワードを抽出（簡易版）
    const techWords = text.match(
      /\b(api|sdk|library|framework|algorithm|pattern|architecture|performance|security|testing|monitoring)\b/gi
    );
    return [...new Set(techWords || [])].slice(0, 5);
  }

  /**
   * 優先度を計算
   */
  private calculatePriority(goal: Goal): number {
    let priority = 50; // ベース

    // メトリクスの進捗状況で調整
    if (goal.metrics && goal.metrics.length > 0) {
      const avgProgress =
        goal.metrics.reduce((sum, m) => sum + (m.current / m.target) * 100, 0) /
        goal.metrics.length;
      // 進捗が中間（30-70%）のものを優先
      if (avgProgress >= 30 && avgProgress <= 70) {
        priority += 20;
      }
    }

    // 永続的な目標（permanent）は少し優先度を上げる
    if (goal.type === "permanent") {
      priority += 10;
    }

    return Math.min(100, priority);
  }

  /**
   * トピックが過去に処理済みかチェック（拡張版）
   * 完了済みでも新しいアプローチを探す仕組みを追加
   */
  async isTopicAlreadyProcessed(topic: ResearchTopic): Promise<{
    processed: boolean;
    reason?: string;
    suggestNewApproach?: boolean;
    previousApproaches?: string[];
  }> {
    if (!topic.relatedGoalId) {
      return { processed: false };
    }

    try {
      // 過去の改善キューを検索
      const allItems = await improvementQueue.getAll();
      const relatedImprovements = allItems.filter(
        (i) => i.relatedGoalId === topic.relatedGoalId
      );

      // 完了済みのアプローチを収集
      const completed = relatedImprovements.filter((i) => i.status === "completed");
      const previousApproaches = completed.map((i) => i.title).slice(0, 5);

      if (completed.length > 0) {
        // 完了済みでも新アプローチを探す（スキップしない）
        return {
          processed: false,  // スキップしない
          suggestNewApproach: true,
          previousApproaches,
          reason: `${completed.length} approaches already tried, seeking new perspectives`,
        };
      }

      // 最近却下されたものがあれば（7日以内）
      const recentSkipped = relatedImprovements.filter((i) => {
        if (i.status !== "skipped") return false;
        const skippedAt = new Date(i.updatedAt);
        const daysSinceSkipped =
          (Date.now() - skippedAt.getTime()) / (1000 * 60 * 60 * 24);
        return daysSinceSkipped < 7;
      });

      // 3回以上スキップされた場合はトピック終了
      if (recentSkipped.length >= 3) {
        return {
          processed: true,
          reason: "Topic exhausted: skipped 3+ times within 7 days",
        };
      }

      // 1-2回スキップされた場合は新アプローチを試す
      if (recentSkipped.length > 0) {
        const skippedApproaches = recentSkipped.map((i) => i.title).slice(0, 3);
        return {
          processed: false,
          suggestNewApproach: true,
          previousApproaches: [...previousApproaches, ...skippedApproaches],
          reason: `${recentSkipped.length} approaches recently skipped, trying new ones`,
        };
      }

      return { processed: false };
    } catch (error) {
      logger.warn("Failed to check if topic already processed", {
        error: error instanceof Error ? error.message : String(error),
      });
      return { processed: false };
    }
  }

  /**
   * トピックを調査
   */
  async research(topic: ResearchTopic): Promise<ResearchResult> {
    logger.info("Starting research", { topic: topic.topic });

    // 重複チェック
    const check = await this.isTopicAlreadyProcessed(topic);
    if (check.processed) {
      logger.info("Skipping research for already processed topic", {
        topic: topic.topic,
        reason: check.reason,
      });
      return {
        topic,
        findings: [],
        approaches: [],
        recommendations: [],
        timestamp: new Date().toISOString(),
        skipped: true,
        skipReason: check.reason,
      };
    }

    // 新アプローチを探す場合は過去のアプローチをプロンプトに含める
    const prompt = this.buildResearchPrompt(topic, {
      suggestNewApproach: check.suggestNewApproach,
      previousApproaches: check.previousApproaches,
    });

    try {
      const response = await this.claude.chat(prompt);
      const parsed = this.parseResponse(response);

      const result: ResearchResult = {
        topic,
        findings: parsed.findings.map((f, i) => ({
          source: f.source,
          summary: f.summary,
          relevance: 0.8 - i * 0.1, // 順序に基づく関連度
          timestamp: new Date().toISOString(),
        })),
        approaches: parsed.approaches.map((a, i) => ({
          id: `approach_${topic.id}_${i}`,
          description: a.description,
          pros: a.pros,
          cons: a.cons,
          estimatedEffort: a.effort,
          confidence: a.confidence,
        })),
        recommendations: parsed.recommendations,
        timestamp: new Date().toISOString(),
      };

      logger.info("Research completed", {
        topic: topic.topic,
        findingsCount: result.findings.length,
        approachesCount: result.approaches.length,
      });

      return result;
    } catch (err) {
      logger.error("Research failed", {
        topic: topic.topic,
        error: err instanceof Error ? err.message : String(err),
      });

      // エラー時は空の結果を返す
      return {
        topic,
        findings: [],
        approaches: [],
        recommendations: [],
        timestamp: new Date().toISOString(),
      };
    }
  }

  /**
   * 調査プロンプトを生成
   */
  private buildResearchPrompt(
    topic: ResearchTopic,
    options?: { suggestNewApproach?: boolean; previousApproaches?: string[] }
  ): string {
    const previousApproachesSection = options?.suggestNewApproach && options.previousApproaches?.length
      ? `
## 注意: 以下のアプローチは既に試行済みです
${options.previousApproaches.map((a, i) => `${i + 1}. ${a}`).join("\n")}

**必ず上記とは異なる新しい視点・アプローチを提案してください。**
既存のアプローチの改善版や、全く異なる手法を検討してください。
`
      : "";

    return `あなたは技術調査エージェントです。以下の目標について**幅広い視点で**調査してください。

## 目標
${topic.topic}

${topic.context ? `## 追加コンテキスト\n${topic.context}` : ""}
${previousApproachesSection}
${this.getSystemContext()}

## 調査の観点（すべて検討すること）

### 1. 技術的アプローチ
- 業界のベストプラクティス、ライブラリ、実装手法

### 2. 戦略的アプローチ（重要）
- コスト最適化の代替戦略
- リソースの役割分担の最適化
- 例: 安価なモデル（GLM4等）で事前検証/セルフレビュー → 高価なモデル（Claude）は最終判断のみ
- 例: 複数の安価なモデルで多角的検証 → 品質維持しながらコスト削減

### 3. 創造的アプローチ
- 従来の方法にとらわれない新しいアイデア
- 問題の再定義（本当に解決すべき問題は何か？）
- 間接的なアプローチ（問題を回避する方法）

### 4. トレードオフ分析
- コスト vs 品質 vs 速度のバランス
- 短期的効果 vs 長期的メンテナンス性

## 出力形式（JSON）
必ず以下のJSON形式で出力してください。JSON以外のテキストは含めないでください。

{
  "findings": [
    {"source": "調査元", "summary": "発見内容", "category": "technical|strategic|creative"}
  ],
  "approaches": [
    {
      "description": "アプローチの説明（具体的な実装方法を含む）",
      "category": "technical|strategic|creative",
      "pros": ["メリット1", "メリット2"],
      "cons": ["デメリット1"],
      "effort": "low|medium|high",
      "confidence": 0.0から1.0の数値,
      "costImpact": "reduce|neutral|increase"
    }
  ],
  "recommendations": [
    "【P1・即実装】具体的な技術提案",
    "【P2・中期】戦略的な提案",
    "【P3・長期/実験】創造的な提案"
  ]
}`;
  }

  /**
   * 現在のシステム構成情報を取得
   */
  private getSystemContext(): string {
    return `## 現在のシステム構成
- 高品質モデル: Claude Sonnet/Opus（高コスト、高精度）
- 安価モデル: GLM4（低コスト）、OpenCode/aider（ローカル、無料）
- ハイブリッド構成: フェーズごとにモデルを使い分け可能

## コスト情報（参考）
- Claude: 入力$3/100万トークン、出力$15/100万トークン
- GLM4: 入力約$0.1/100万トークン、出力約$0.2/100万トークン

## 最適化の方向性
- 高コストモデルの使用を最小化
- 安価モデルで可能な処理は積極的に移譲
- 品質が必要な判断のみ高コストモデルを使用`;
  }

  /**
   * AI応答をパース
   */
  private parseResponse(response: string): ResearchAIResponse {
    const parsed = parseJSONObject<{
      findings?: Array<Record<string, unknown>>;
      approaches?: Array<Record<string, unknown>>;
      recommendations?: string[];
    }>(response);

    if (parsed) {
      // 必須フィールドの検証とデフォルト値の設定
      return {
        findings: Array.isArray(parsed.findings)
          ? parsed.findings.map((f: Record<string, unknown>) => ({
              source: String(f.source || "unknown"),
              summary: String(f.summary || ""),
            }))
          : [],
        approaches: Array.isArray(parsed.approaches)
          ? parsed.approaches.map((a: Record<string, unknown>) => ({
              description: String(a.description || ""),
              pros: Array.isArray(a.pros) ? a.pros.map(String) : [],
              cons: Array.isArray(a.cons) ? a.cons.map(String) : [],
              effort: this.normalizeEffort(a.effort),
              confidence: this.normalizeConfidence(a.confidence),
            }))
          : [],
        recommendations: Array.isArray(parsed.recommendations)
          ? parsed.recommendations.map(String)
          : [],
      };
    }

    // パース失敗時のデフォルト
    logger.warn("Failed to parse research response");
    return {
      findings: [],
      approaches: [],
      recommendations: [],
    };
  }

  /**
   * 工数を正規化
   */
  private normalizeEffort(value: unknown): "low" | "medium" | "high" {
    const str = String(value).toLowerCase();
    if (str === "low" || str === "medium" || str === "high") {
      return str;
    }
    return "medium";
  }

  /**
   * 信頼度を正規化
   */
  private normalizeConfidence(value: unknown): number {
    const num = Number(value);
    if (isNaN(num)) return 0.5;
    return Math.max(0, Math.min(1, num));
  }
}
