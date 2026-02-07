/**
 * 簡略化レビュー管理
 *
 * 2段階レビュー: 初回レビュー → 拒否時は理由付きで1回リトライ
 * 旧三審制（MultiJudgeReviewer + RejectionAnalyzer）を統合・簡略化
 */

import { logger } from "../core/logger.js";
import { ClaudeProvider } from "../ai/claude-provider.js";
import { parseJSONObject } from "../ai/json-parser.js";
import { TrialSystemResult } from "./review-types.js";

export class AppealManager {
  private claudeProvider: ClaudeProvider;

  constructor() {
    this.claudeProvider = new ClaudeProvider();
  }

  /**
   * 最大2回のレビューを実行
   * 1回目で拒否された場合、拒否理由を添えて1回だけリトライ
   */
  async runTrialSystem(
    filePath: string,
    changeDescription: string,
    proposedCode?: string
  ): Promise<TrialSystemResult> {
    logger.info("Protected file review started", { file: filePath });

    // 第1回レビュー
    const firstResult = await this.reviewOnce(filePath, changeDescription, proposedCode);

    if (firstResult.approved) {
      logger.info("Review approved on first attempt", { file: filePath });
      return {
        approved: true,
        trialsCompleted: 1,
        trialHistory: [],
        finalReason: firstResult.reason,
      };
    }

    // 拒否された場合、理由を添えて1回リトライ
    logger.info("First review rejected, retrying with context", {
      file: filePath,
      reason: firstResult.reason,
    });

    const retryResult = await this.reviewOnce(
      filePath,
      changeDescription,
      proposedCode,
      firstResult.reason
    );

    return {
      approved: retryResult.approved,
      trialsCompleted: 2,
      trialHistory: [],
      finalReason: retryResult.approved
        ? retryResult.reason
        : `Rejected after retry: ${retryResult.reason}`,
    };
  }

  private async reviewOnce(
    filePath: string,
    changeDescription: string,
    proposedCode?: string,
    previousRejectionReason?: string
  ): Promise<{ approved: boolean; reason: string }> {
    const prompt = this.buildPrompt(filePath, changeDescription, proposedCode, previousRejectionReason);

    try {
      const response = await this.claudeProvider.chat(prompt);
      const parsed = parseJSONObject<{ approved: boolean; reason: string }>(response);

      if (parsed && typeof parsed.approved === "boolean") {
        return { approved: parsed.approved, reason: parsed.reason || "No reason" };
      }

      return { approved: false, reason: "Failed to parse review response" };
    } catch (err) {
      logger.warn("Review request failed", { error: err instanceof Error ? err.message : String(err) });
      return { approved: false, reason: "Review unavailable" };
    }
  }

  private buildPrompt(
    filePath: string,
    changeDescription: string,
    proposedCode?: string,
    previousRejectionReason?: string
  ): string {
    let prompt = `あなたはセキュリティレビュアーです。保護ファイルへの変更が正当か判断してください。

## 対象ファイル
${filePath}

## 変更の説明
${changeDescription}

${proposedCode ? `## 提案されたコード（一部）
\`\`\`
${proposedCode.slice(0, 1500)}
\`\`\`` : ""}`;

    if (previousRejectionReason) {
      prompt += `

## 前回の拒否理由
${previousRejectionReason}

上記の拒否理由を踏まえ、変更の正当性を再評価してください。`;
    }

    prompt += `

## 判断基準
1. システムの安定性を損なわないか
2. セキュリティ機構を弱体化させないか
3. 正当な改善（バグ修正、パフォーマンス改善等）であるか
4. 変更が必要最小限であるか

## 回答形式（JSON）
{"approved": true/false, "reason": "判断理由"}

JSONのみを出力してください。`;

    return prompt;
  }
}
