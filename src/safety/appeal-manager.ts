/**
 * 三審制上訴管理
 *
 * 日本の三審制（第一審→控訴審→上告審）に倣い、
 * 拒否時に最大3回の審理チャンスを提供する。
 *
 * - 第一審: 初回マルチジャッジレビュー
 * - 控訴審: 拒否理由が改善可能なら補完情報を付与して再審理
 * - 上告審: 最終審理。ここで拒否なら確定
 */

import { logger } from "../core/logger.js";
import { MultiJudgeReviewer } from "./multi-judge-reviewer.js";
import { RejectionAnalyzer } from "./rejection-analyzer.js";
import {
  MultiJudgeConfig,
  MultiJudgeReviewResult,
  TrialLevel,
  TrialSystemResult,
  DEFAULT_MULTI_JUDGE_CONFIG,
  RejectionAnalysis,
} from "./review-types.js";
import * as fs from "fs";
import * as path from "path";

const TRIAL_LEVELS: TrialLevel[] = ["first", "appeal", "final"];

const TRIAL_LEVEL_NAMES: Record<TrialLevel, string> = {
  first: "第一審",
  appeal: "控訴審",
  final: "上告審",
};

export class AppealManager {
  private reviewer: MultiJudgeReviewer;
  private rejectionAnalyzer: RejectionAnalyzer;
  private config: MultiJudgeConfig;

  constructor(config: Partial<MultiJudgeConfig> = {}) {
    this.config = { ...DEFAULT_MULTI_JUDGE_CONFIG, ...config };
    this.reviewer = new MultiJudgeReviewer(this.config);
    this.rejectionAnalyzer = new RejectionAnalyzer();
  }

  /**
   * 三審制フローを実行
   * 第一審→（拒否で改善可能なら）控訴審→（拒否で改善可能なら）上告審
   */
  async runTrialSystem(
    filePath: string,
    changeDescription: string,
    proposedCode?: string
  ): Promise<TrialSystemResult> {
    const trialHistory: MultiJudgeReviewResult[] = [];
    let lastRejectionAnalysis: RejectionAnalysis | undefined;

    logger.info("三審制レビュー開始", { file: filePath });

    for (let i = 0; i < this.config.maxTrials && i < TRIAL_LEVELS.length; i++) {
      const trialLevel = TRIAL_LEVELS[i];
      const trialName = TRIAL_LEVEL_NAMES[trialLevel];

      logger.info(`${trialName}開始`, { file: filePath, trial: i + 1 });

      // 補完情報の生成（控訴審・上告審のみ）
      const supplements = i > 0 && lastRejectionAnalysis
        ? this.generateSupplements(
            filePath,
            changeDescription,
            proposedCode,
            lastRejectionAnalysis
          )
        : undefined;

      const result = await this.reviewer.review({
        filePath,
        changeDescription,
        proposedCode,
        trialLevel,
        supplements,
      });

      trialHistory.push(result);

      if (result.approved) {
        logger.info(`${trialName}で承認`, {
          file: filePath,
          trial: i + 1,
          weightedApproval: result.votingSummary.weightedApproval,
        });

        return {
          approved: true,
          trialsCompleted: i + 1,
          trialHistory,
          finalReason: result.reason,
        };
      }

      // 拒否された場合
      lastRejectionAnalysis = result.rejectionAnalysis;

      // 上訴可能か判定
      if (!result.canAppeal) {
        logger.info(`${trialName}で拒否（上訴不可）`, {
          file: filePath,
          trial: i + 1,
          reason: result.reason,
        });

        return {
          approved: false,
          trialsCompleted: i + 1,
          trialHistory,
          finalReason: `${trialName}で拒否確定: ${result.reason}`,
        };
      }

      // 最終審（上告審）で拒否の場合は確定
      if (trialLevel === "final") {
        logger.info("上告審で拒否（最終判定）", {
          file: filePath,
          reason: result.reason,
        });

        return {
          approved: false,
          trialsCompleted: i + 1,
          trialHistory,
          finalReason: `上告審で最終拒否: ${result.reason}`,
        };
      }

      logger.info(`${trialName}で拒否、上訴へ`, {
        file: filePath,
        trial: i + 1,
        nextTrial: TRIAL_LEVEL_NAMES[TRIAL_LEVELS[i + 1]],
        rejectionCategory: lastRejectionAnalysis?.category,
      });
    }

    // ここに到達するのはmaxTrials < 3の場合のみ
    return {
      approved: false,
      trialsCompleted: trialHistory.length,
      trialHistory,
      finalReason: `全${trialHistory.length}審で拒否`,
    };
  }

  /**
   * 拒否理由に基づいて補完情報を自動生成
   */
  private generateSupplements(
    filePath: string,
    changeDescription: string,
    proposedCode: string | undefined,
    rejectionAnalysis: RejectionAnalysis
  ): Record<string, string> {
    const supplements: Record<string, string> = {};

    for (const required of rejectionAnalysis.requiredSupplements) {
      switch (required) {
        case "diff":
          supplements["diff"] = this.generateDiffSupplement(filePath, proposedCode);
          break;
        case "context":
          supplements["context"] = this.generateContextSupplement(filePath, changeDescription);
          break;
        case "justification":
          supplements["justification"] = this.generateJustificationSupplement(changeDescription);
          break;
        default:
          supplements[required] = `補完情報: ${required}`;
      }
    }

    // 前審の拒否理由を常に添付
    supplements["前審の拒否理由"] = rejectionAnalysis.originalReason;
    supplements["拒否カテゴリ"] = rejectionAnalysis.category;

    return supplements;
  }

  /**
   * diff情報の補完
   */
  private generateDiffSupplement(filePath: string, proposedCode?: string): string {
    try {
      const absPath = path.resolve(filePath);
      if (fs.existsSync(absPath)) {
        const currentContent = fs.readFileSync(absPath, "utf-8");
        const currentLines = currentContent.split("\n");
        const proposedLines = (proposedCode || "").split("\n");

        const diffLines: string[] = [];
        const maxLines = Math.max(currentLines.length, proposedLines.length);

        for (let i = 0; i < Math.min(maxLines, 50); i++) {
          const current = currentLines[i] || "";
          const proposed = proposedLines[i] || "";
          if (current !== proposed) {
            diffLines.push(`L${i + 1}: - ${current}`);
            diffLines.push(`L${i + 1}: + ${proposed}`);
          }
        }

        if (diffLines.length === 0) {
          return "変更なし（現在のファイルと同一）";
        }

        return diffLines.join("\n");
      }
    } catch {
      // ファイル読み込み失敗
    }

    return proposedCode
      ? `新しいコード（先頭500文字）:\n${proposedCode.slice(0, 500)}`
      : "diff情報なし";
  }

  /**
   * コンテキスト情報の補完
   */
  private generateContextSupplement(filePath: string, changeDescription: string): string {
    const parts: string[] = [];

    parts.push(`対象ファイル: ${filePath}`);
    parts.push(`変更目的: ${changeDescription}`);

    // ファイルの既存内容の概要
    try {
      const absPath = path.resolve(filePath);
      if (fs.existsSync(absPath)) {
        const content = fs.readFileSync(absPath, "utf-8");
        const lines = content.split("\n");
        parts.push(`現在のファイル: ${lines.length}行`);

        // import文を抽出して依存関係を表示
        const imports = lines
          .filter((l) => l.startsWith("import "))
          .slice(0, 10);
        if (imports.length > 0) {
          parts.push(`依存関係:\n${imports.join("\n")}`);
        }
      }
    } catch {
      // 無視
    }

    return parts.join("\n\n");
  }

  /**
   * 正当性の補完
   */
  private generateJustificationSupplement(changeDescription: string): string {
    return `この変更は自律改善サイクルの一環として提案されました。
目的: ${changeDescription}
正当性: システムの改善・バグ修正・安定性向上のために必要な変更です。
変更は最小限に留められ、既存の動作を破壊しません。`;
  }
}
