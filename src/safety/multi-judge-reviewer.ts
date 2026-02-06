/**
 * マルチジャッジレビュー
 *
 * Claude（裁判官・重み60%）+ OpenCode（陪席・重み40%）の2名構成で
 * 保護ファイルへの変更を評価する。加重投票で閾値0.6以上なら承認。
 */

import { ClaudeProvider } from "../ai/claude-provider.js";
import { OpenCodeProvider } from "../ai/opencode-provider.js";
import { parseJSONObject } from "../ai/json-parser.js";
import { logger } from "../core/logger.js";
import {
  JudgeVerdict,
  VotingSummary,
  MultiJudgeConfig,
  MultiJudgeReviewResult,
  DEFAULT_MULTI_JUDGE_CONFIG,
  TrialLevel,
} from "./review-types.js";
import { RejectionAnalyzer } from "./rejection-analyzer.js";

interface ReviewRequest {
  filePath: string;
  changeDescription: string;
  proposedCode?: string;
  trialLevel: TrialLevel;
  supplements?: Record<string, string>;
}

const TRIAL_LEVEL_LABELS: Record<TrialLevel, string> = {
  first: "第一審",
  appeal: "控訴審（第二審）",
  final: "上告審（第三審）",
};

export class MultiJudgeReviewer {
  private claudeProvider: ClaudeProvider;
  private openCodeProvider: OpenCodeProvider;
  private config: MultiJudgeConfig;
  private rejectionAnalyzer: RejectionAnalyzer;

  constructor(config: Partial<MultiJudgeConfig> = {}) {
    this.config = { ...DEFAULT_MULTI_JUDGE_CONFIG, ...config };
    this.claudeProvider = new ClaudeProvider();
    this.openCodeProvider = new OpenCodeProvider();
    this.rejectionAnalyzer = new RejectionAnalyzer();
  }

  async review(request: ReviewRequest): Promise<MultiJudgeReviewResult> {
    const trialLabel = TRIAL_LEVEL_LABELS[request.trialLevel];
    logger.info(`マルチジャッジレビュー開始: ${trialLabel}`, {
      file: request.filePath,
      trialLevel: request.trialLevel,
    });

    const prompt = this.buildReviewPrompt(request);

    // Claude + OpenCodeに並列レビュー依頼
    const [claudeResult, openCodeResult] = await Promise.allSettled([
      this.getJudgeVerdict("claude", this.claudeProvider, prompt),
      this.getJudgeVerdict("opencode", this.openCodeProvider, prompt),
    ]);

    const verdicts: JudgeVerdict[] = [];

    if (claudeResult.status === "fulfilled") {
      verdicts.push(claudeResult.value);
    } else {
      logger.warn("Claudeレビュー失敗", { error: claudeResult.reason });
    }

    if (openCodeResult.status === "fulfilled") {
      verdicts.push(openCodeResult.value);
    } else {
      logger.warn("OpenCodeレビュー失敗", { error: openCodeResult.reason });
    }

    // 審判が足りない場合のフォールバック
    if (verdicts.length < this.config.requiredJudges) {
      if (this.config.fallbackBehavior === "single-judge" && verdicts.length > 0) {
        logger.warn("審判不足、単独審判モードで続行", { available: verdicts.length });
      } else {
        logger.error("審判不足、レビュー拒否", { available: verdicts.length });
        return {
          approved: false,
          verdicts,
          votingSummary: this.createEmptyVotingSummary("審判不足"),
          reason: `必要な審判数（${this.config.requiredJudges}）に満たない`,
          canAppeal: false,
        };
      }
    }

    // 加重投票
    const votingSummary = this.calculateWeightedVote(verdicts);

    const approved = votingSummary.weightedApproval >= this.config.votingThreshold;

    // 拒否の場合、改善可能かどうか解析
    let rejectionAnalysis;
    let canAppeal = false;
    if (!approved) {
      const rejectionReasons = verdicts
        .filter((v) => !v.approved)
        .map((v) => v.reason)
        .join("; ");
      rejectionAnalysis = this.rejectionAnalyzer.analyze(rejectionReasons);
      canAppeal = rejectionAnalysis.isRemediable;
    }

    const reason = approved
      ? `${trialLabel}承認（加重得票率: ${(votingSummary.weightedApproval * 100).toFixed(1)}%）`
      : `${trialLabel}拒否（加重得票率: ${(votingSummary.weightedApproval * 100).toFixed(1)}%、閾値: ${(this.config.votingThreshold * 100).toFixed(1)}%）`;

    logger.info(`マルチジャッジレビュー完了: ${trialLabel}`, {
      approved,
      weightedApproval: votingSummary.weightedApproval,
      verdicts: verdicts.map((v) => ({ judge: v.judgeName, approved: v.approved })),
      canAppeal,
    });

    return {
      approved,
      verdicts,
      votingSummary,
      reason,
      canAppeal,
      rejectionAnalysis,
    };
  }

  private buildReviewPrompt(request: ReviewRequest): string {
    const trialLabel = TRIAL_LEVEL_LABELS[request.trialLevel];

    let supplementInfo = "";
    if (request.supplements && Object.keys(request.supplements).length > 0) {
      supplementInfo = "\n## 補完情報（前審の拒否に対する追加情報）\n";
      for (const [key, value] of Object.entries(request.supplements)) {
        supplementInfo += `### ${key}\n${value}\n\n`;
      }
    }

    return `あなたはセキュリティレビュアーです。【${trialLabel}】として、保護ファイルへの変更を審理してください。

## 対象ファイル
${request.filePath}

## 変更の説明
${request.changeDescription}

${request.proposedCode ? `## 提案されたコード（一部）
\`\`\`
${request.proposedCode.slice(0, 1500)}
\`\`\`` : ""}
${supplementInfo}
## 判断基準
1. 変更がシステムの安定性を損なわないか
2. セキュリティ機構を弱体化させないか
3. 変更の目的が正当な改善であるか
4. 変更が必要最小限であるか

## 回答形式（JSON）
{"approved": true/false, "reason": "判断理由", "confidence": 0.0-1.0}

JSONのみを出力してください。`;
  }

  private async getJudgeVerdict(
    judgeName: string,
    provider: { chat(prompt: string): Promise<string> },
    prompt: string
  ): Promise<JudgeVerdict> {
    const response = await provider.chat(prompt);
    const parsed = parseJSONObject<{
      approved: boolean;
      reason: string;
      confidence?: number;
    }>(response);

    if (!parsed || typeof parsed.approved !== "boolean") {
      throw new Error(`${judgeName}のレスポンスをパースできません`);
    }

    return {
      judgeName,
      approved: parsed.approved,
      reason: parsed.reason || "理由なし",
      confidence: typeof parsed.confidence === "number"
        ? Math.min(1, Math.max(0, parsed.confidence))
        : 0.7, // デフォルトconfidence
    };
  }

  private calculateWeightedVote(verdicts: JudgeVerdict[]): VotingSummary {
    let weightedApprovalSum = 0;
    let totalWeight = 0;
    let approvedCount = 0;
    let rejectedCount = 0;

    for (const verdict of verdicts) {
      const weight = this.getJudgeWeight(verdict.judgeName);
      const weightedVote = weight * verdict.confidence * (verdict.approved ? 1 : 0);
      weightedApprovalSum += weightedVote;
      totalWeight += weight * verdict.confidence;

      if (verdict.approved) {
        approvedCount++;
      } else {
        rejectedCount++;
      }
    }

    const weightedApproval = totalWeight > 0 ? weightedApprovalSum / totalWeight : 0;

    const decidingFactors = verdicts.map(
      (v) => `${v.judgeName}:${v.approved ? "承認" : "拒否"}(信頼度${(v.confidence * 100).toFixed(0)}%)`
    );

    return {
      weightedApproval,
      totalJudges: verdicts.length,
      approvedCount,
      rejectedCount,
      decidingFactor: decidingFactors.join(", "),
    };
  }

  private getJudgeWeight(judgeName: string): number {
    const weights = this.config.judgeWeights as Record<string, number>;
    return weights[judgeName] ?? 0.3;
  }

  private createEmptyVotingSummary(reason: string): VotingSummary {
    return {
      weightedApproval: 0,
      totalJudges: 0,
      approvedCount: 0,
      rejectedCount: 0,
      decidingFactor: reason,
    };
  }
}
