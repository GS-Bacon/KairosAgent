/**
 * Daily Reporter
 *
 * 1日の全サイクルログを集約してレポート生成
 * 保存先: workspace/logs/YYYY-MM-DD-daily-report.md
 * 実行: 毎日 23:55
 */

import { writeFileSync, existsSync, mkdirSync, readdirSync } from "fs";
import { join } from "path";
import { cycleLogger, CycleLogData } from "./cycle-logger.js";
import { logger } from "./logger.js";
import { aiSummarizer, DailySummary, CycleSummary } from "../ai/summarizer.js";

const LOG_DIR = "./workspace/logs";

export interface DailyReportData {
  date: string;
  cyclesExecuted: number;
  cyclesSkipped: number;
  totalRuntime: number;
  successRate: number;
  issuesResolved: number;
  improvementsApplied: number;
  troublesEncountered: number;
  totalTokenInput: number;
  totalTokenOutput: number;
  cycleSummaries: Array<{
    cycleId: string;
    startTime: string;
    duration: number;
    success: boolean;
    changes: number;
    issues: number;
    aiSummary?: CycleSummary;
  }>;
  aiSummary?: DailySummary;
}

class DailyReporter {
  /**
   * 指定日の日報を生成
   * @param date YYYY-MM-DD形式。省略時は今日
   */
  async generate(date?: string): Promise<string | null> {
    const targetDate = date || new Date().toISOString().split("T")[0];

    logger.info("Generating daily report", { date: targetDate });

    const cycleLogs = cycleLogger.getCycleLogsForDate(targetDate);

    if (cycleLogs.length === 0) {
      logger.info("No cycle logs found for date", { date: targetDate });
      return null;
    }

    const reportData = this.buildReportData(targetDate, cycleLogs);

    // AI要約を生成
    try {
      const cycleSummaries: CycleSummary[] = reportData.cycleSummaries
        .filter(c => c.aiSummary)
        .map(c => c.aiSummary!);

      const stats = {
        cyclesExecuted: reportData.cyclesExecuted,
        successRate: reportData.successRate,
        troublesEncountered: reportData.troublesEncountered,
        totalTokenInput: reportData.totalTokenInput,
        totalTokenOutput: reportData.totalTokenOutput,
      };

      const aiSummary = await aiSummarizer.summarizeDaily(cycleSummaries, stats);
      if (aiSummary) {
        reportData.aiSummary = aiSummary;
      } else {
        reportData.aiSummary = aiSummarizer.generateFallbackDailySummary(stats);
      }
    } catch (error) {
      logger.warn("Failed to generate daily AI summary, using fallback", { error });
      reportData.aiSummary = aiSummarizer.generateFallbackDailySummary({
        cyclesExecuted: reportData.cyclesExecuted,
        successRate: reportData.successRate,
        troublesEncountered: reportData.troublesEncountered,
        totalTokenInput: reportData.totalTokenInput,
        totalTokenOutput: reportData.totalTokenOutput,
      });
    }

    const markdown = this.formatMarkdown(reportData);
    const filename = `${targetDate}-daily-report.md`;

    try {
      this.ensureLogDir();
      const filepath = join(LOG_DIR, filename);
      writeFileSync(filepath, markdown);
      logger.info("Daily report saved", { filepath, cyclesCount: cycleLogs.length });
      return filepath;
    } catch (error) {
      logger.error("Failed to save daily report", { error });
      return null;
    }
  }

  /**
   * レポートデータを構築
   */
  private buildReportData(date: string, cycleLogs: CycleLogData[]): DailyReportData {
    let totalRuntime = 0;
    let successCount = 0;
    let issuesResolved = 0;
    let improvementsApplied = 0;
    let troublesEncountered = 0;
    let totalTokenInput = 0;
    let totalTokenOutput = 0;
    let cyclesSkipped = 0;

    const cycleSummaries: DailyReportData["cycleSummaries"] = [];

    for (const log of cycleLogs) {
      totalRuntime += log.duration;

      if (log.skippedEarly) {
        cyclesSkipped++;
      }

      if (log.success) {
        successCount++;
      }

      // 変更があればissuesResolved/improvementsAppliedとしてカウント
      const changes = log.changesMade.length;
      improvementsApplied += changes;

      // 問題検出数
      issuesResolved += log.issuesDetected.length;

      // トラブル数
      troublesEncountered += log.troubles.length;

      // トークン使用量
      if (log.tokenUsage) {
        totalTokenInput += log.tokenUsage.totalInput;
        totalTokenOutput += log.tokenUsage.totalOutput;
      }

      cycleSummaries.push({
        cycleId: log.cycleId,
        startTime: log.startTime.toISOString(),
        duration: log.duration,
        success: log.success,
        changes,
        issues: log.issuesDetected.length,
        aiSummary: log.aiSummary,
      });
    }

    const cyclesExecuted = cycleLogs.length;
    const successRate = cyclesExecuted > 0 ? (successCount / cyclesExecuted) * 100 : 0;

    return {
      date,
      cyclesExecuted,
      cyclesSkipped,
      totalRuntime,
      successRate,
      issuesResolved,
      improvementsApplied,
      troublesEncountered,
      totalTokenInput,
      totalTokenOutput,
      cycleSummaries,
    };
  }

  /**
   * Markdown形式でフォーマット
   */
  private formatMarkdown(data: DailyReportData): string {
    const lines: string[] = [];

    // Header
    lines.push(`# Daily Report: ${data.date}`);
    lines.push("");

    // AI Analysis Section（最初に表示）
    if (data.aiSummary) {
      lines.push("## AI Analysis");
      lines.push(`**Overall**: ${data.aiSummary.overallStatus}`);
      lines.push("");

      if (data.aiSummary.mainIssues.length > 0) {
        lines.push("**Main Issues**:");
        for (const issue of data.aiSummary.mainIssues) {
          lines.push(`- ${issue}`);
        }
        lines.push("");
      }

      if (data.aiSummary.trendAnalysis) {
        lines.push("**Trend Analysis**:");
        lines.push(data.aiSummary.trendAnalysis);
        lines.push("");
      }

      if (data.aiSummary.recommendations.length > 0) {
        lines.push("**Recommendations**:");
        for (const rec of data.aiSummary.recommendations) {
          lines.push(`- ${rec}`);
        }
        lines.push("");
      }

      lines.push("---");
      lines.push("");
    }

    // Overview
    lines.push("## Overview");
    lines.push(`- **Cycles Executed**: ${data.cyclesExecuted}`);
    if (data.cyclesSkipped > 0) {
      lines.push(`- **Cycles Skipped (No Work)**: ${data.cyclesSkipped}`);
    }
    lines.push(`- **Total Runtime**: ${this.formatDuration(data.totalRuntime)}`);
    lines.push(`- **Success Rate**: ${data.successRate.toFixed(1)}%`);
    lines.push("");

    // Work Summary
    lines.push("## Work Summary");
    lines.push(`- **Issues Detected**: ${data.issuesResolved}`);
    lines.push(`- **Improvements Applied**: ${data.improvementsApplied}`);
    lines.push(`- **Troubles Encountered**: ${data.troublesEncountered}`);
    lines.push("");

    // Resource Usage
    lines.push("## Resource Usage");
    lines.push(`- **Total Input Tokens**: ${data.totalTokenInput.toLocaleString()}`);
    lines.push(`- **Total Output Tokens**: ${data.totalTokenOutput.toLocaleString()}`);
    lines.push(`- **Total Tokens**: ${(data.totalTokenInput + data.totalTokenOutput).toLocaleString()}`);
    lines.push("");

    // Cycle Details
    if (data.cycleSummaries.length > 0) {
      lines.push("## Cycle Details");
      lines.push("");
      lines.push("| Cycle ID | Time | Duration | Status | Changes | Issues |");
      lines.push("|----------|------|----------|--------|---------|--------|");

      for (const cycle of data.cycleSummaries) {
        const time = new Date(cycle.startTime).toLocaleTimeString("ja-JP", {
          hour: "2-digit",
          minute: "2-digit",
        });
        const duration = (cycle.duration / 1000).toFixed(0) + "s";
        const status = cycle.success ? "✓" : "✗";

        lines.push(
          `| ${this.truncateCycleId(cycle.cycleId)} | ${time} | ${duration} | ${status} | ${cycle.changes} | ${cycle.issues} |`
        );
      }
      lines.push("");
    }

    return lines.join("\n");
  }

  /**
   * 時間をフォーマット
   */
  private formatDuration(ms: number): string {
    const seconds = Math.floor(ms / 1000);
    const minutes = Math.floor(seconds / 60);
    const hours = Math.floor(minutes / 60);

    if (hours > 0) {
      return `${hours}h ${minutes % 60}m`;
    } else if (minutes > 0) {
      return `${minutes}m ${seconds % 60}s`;
    } else {
      return `${seconds}s`;
    }
  }

  /**
   * サイクルIDを短縮
   */
  private truncateCycleId(cycleId: string): string {
    return cycleId.replace("cycle_", "").substring(0, 10);
  }

  /**
   * ログディレクトリを確保
   */
  private ensureLogDir(): void {
    if (!existsSync(LOG_DIR)) {
      mkdirSync(LOG_DIR, { recursive: true });
    }
  }

  /**
   * 既存の日報ファイル一覧を取得
   */
  getExistingReports(): string[] {
    if (!existsSync(LOG_DIR)) {
      return [];
    }

    return readdirSync(LOG_DIR)
      .filter((f) => f.endsWith("-daily-report.md"))
      .sort()
      .reverse();
  }
}

export const dailyReporter = new DailyReporter();
