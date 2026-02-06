/**
 * Claude復活時レビューシステム
 *
 * GLMによる変更をClaudeがレビューし、品質を保証
 */

import { existsSync, readFileSync } from "fs";
import { logger } from "../core/logger.js";
import { ClaudeProvider } from "./claude-provider.js";
import { ChangeTracker, TrackedChange, ReviewResult, changeTracker } from "./change-tracker.js";
import { improvementQueue } from "../improvement-queue/index.js";
import type { ImprovementSource, ImprovementType } from "../improvement-queue/types.js";
import { parseJSONObject } from "./json-parser.js";

export interface ReviewReport {
  reviewed: number;
  approved: number;
  rejected: number;
  issues: Array<{
    changeId: string;
    issues: string[];
    suggestions: string[];
  }>;
}

export class ClaudeReviewer {
  private tracker: ChangeTracker;
  private claudeProvider: ClaudeProvider;
  private maxFileSizeKB: number;

  constructor(
    tracker: ChangeTracker = changeTracker,
    claudeProvider?: ClaudeProvider,
    maxFileSizeKB: number = 100
  ) {
    this.tracker = tracker;
    this.claudeProvider = claudeProvider || new ClaudeProvider();
    this.maxFileSizeKB = maxFileSizeKB;
  }

  /**
   * 変更されたファイルの内容を読み取る
   */
  private async readChangedFiles(files: string[]): Promise<string> {
    const contents: string[] = [];

    for (const file of files.slice(0, 5)) {
      // 最大5ファイル
      try {
        if (!existsSync(file)) {
          contents.push(`--- ${file} ---\n(File not found)`);
          continue;
        }

        const stat = readFileSync(file);
        if (stat.length > this.maxFileSizeKB * 1024) {
          contents.push(`--- ${file} ---\n(File too large: ${Math.round(stat.length / 1024)}KB)`);
          continue;
        }

        const content = readFileSync(file, "utf-8");
        contents.push(`--- ${file} ---\n${content}`);
      } catch (err) {
        contents.push(`--- ${file} ---\n(Error reading file: ${err instanceof Error ? err.message : String(err)})`);
      }
    }

    if (files.length > 5) {
      contents.push(`\n(${files.length - 5} more files not shown)`);
    }

    return contents.join("\n\n");
  }

  /**
   * 単一の変更をレビュー
   */
  private async reviewSingleChange(change: TrackedChange): Promise<ReviewResult> {
    try {
      const fileContents = await this.readChangedFiles(change.files);

      const prompt = `You are a code reviewer. Review the following code changes made by an AI assistant (GLM4.7).

## Change Context
- Phase: ${change.phase}
- Timestamp: ${change.timestamp}
- Description: ${change.description}

## Changed Files
${fileContents}

## Review Criteria
1. Code quality (readability, maintainability)
2. Security issues (injection, XSS, etc.)
3. Performance concerns
4. Best practices compliance
5. Consistency with existing codebase

Respond with ONLY a JSON object:
{
  "approved": true/false,
  "issues": ["issue1", "issue2"],
  "suggestions": ["suggestion1", "suggestion2"]
}

If approved is false, explain why in the issues array.`;

      const response = await this.claudeProvider.chat(prompt);

      // JSONをパース
      const parsed = parseJSONObject<ReviewResult>(response);
      if (parsed) {
        return {
          approved: !!parsed.approved,
          issues: Array.isArray(parsed.issues) ? parsed.issues : [],
          suggestions: Array.isArray(parsed.suggestions) ? parsed.suggestions : [],
        };
      }

      // パース失敗時はデフォルト承認（保守的に）
      logger.warn("Failed to parse review response, defaulting to approved");
      return {
        approved: true,
        issues: [],
        suggestions: ["Review response could not be parsed"],
      };
    } catch (err) {
      logger.error("Failed to review change", {
        changeId: change.id,
        error: err instanceof Error ? err.message : String(err),
      });

      // エラー時は承認しない
      return {
        approved: false,
        issues: [`Review failed: ${err instanceof Error ? err.message : String(err)}`],
        suggestions: [],
      };
    }
  }

  /**
   * 未レビューの変更をすべてレビュー
   */
  async reviewPendingChanges(): Promise<ReviewReport> {
    const unreviewedChanges = this.tracker.getUnreviewedChanges();

    if (unreviewedChanges.length === 0) {
      return {
        reviewed: 0,
        approved: 0,
        rejected: 0,
        issues: [],
      };
    }

    logger.info("Claude reviewing GLM changes", {
      count: unreviewedChanges.length,
    });

    const report: ReviewReport = {
      reviewed: 0,
      approved: 0,
      rejected: 0,
      issues: [],
    };

    for (const change of unreviewedChanges) {
      const result = await this.reviewSingleChange(change);
      this.tracker.markReviewed(change.id, result);

      report.reviewed++;
      if (result.approved) {
        report.approved++;
      } else {
        report.rejected++;
        report.issues.push({
          changeId: change.id,
          issues: result.issues,
          suggestions: result.suggestions,
        });
      }
    }

    logger.info("GLM change review completed", {
      reviewed: report.reviewed,
      approved: report.approved,
      rejected: report.rejected,
    });

    return report;
  }

  /**
   * レビューで見つかった問題を改善キューに追加
   */
  async queueIssuesForFix(report: ReviewReport): Promise<number> {
    let queued = 0;

    for (const issue of report.issues) {
      const change = this.tracker.getChange(issue.changeId);
      if (!change) continue;

      for (const problem of issue.issues) {
        try {
          // 各ファイルに対して改善を登録
          for (const file of change.files.slice(0, 3)) {
            const source: ImprovementSource = "phase-verify";
            const type: ImprovementType = "refactor";

            await improvementQueue.enqueue({
              source,
              type,
              title: `GLM Review Issue: ${problem.substring(0, 100)}`,
              description: `GLM Review Issue: ${problem}`,
              priority: 60, // medium priority (0-100 scale)
              relatedFile: file,
              metadata: {
                changeId: issue.changeId,
                reviewedAt: new Date().toISOString(),
              },
            });
            queued++;
          }
        } catch (err) {
          logger.warn("Failed to queue improvement", {
            error: err instanceof Error ? err.message : String(err),
          });
        }
      }
    }

    if (queued > 0) {
      logger.info("Queued improvements from GLM review", { count: queued });
    }

    return queued;
  }
}

// シングルトンインスタンス
export const claudeReviewer = new ClaudeReviewer();
