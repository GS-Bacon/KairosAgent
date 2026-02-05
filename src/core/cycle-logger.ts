/**
 * Cycle Logger
 *
 * 作業が発生したサイクルのみ、ログを自動保存
 * 保存先: workspace/logs/YYYY-MM-DD-cycle-{cycleId}.md
 */

import { writeFileSync, existsSync, mkdirSync, readdirSync, readFileSync } from "fs";
import { join } from "path";
import { CycleContext } from "../phases/types.js";
import { logger } from "./logger.js";

const LOG_DIR = "./workspace/logs";

export interface CycleLogData {
  cycleId: string;
  startTime: Date;
  endTime: Date;
  duration: number;
  success: boolean;
  skippedEarly: boolean;
  issuesDetected: Array<{
    type: string;
    message: string;
    file?: string;
  }>;
  changesMade: Array<{
    file: string;
    changeType: string;
  }>;
  troubles: Array<{
    type: string;
    message: string;
  }>;
  tokenUsage?: {
    totalInput: number;
    totalOutput: number;
  };
}

class CycleLogger {
  /**
   * サイクル完了時にログを保存するかどうかを判定
   */
  shouldLog(context: CycleContext, skippedEarly: boolean): boolean {
    // 早期終了した場合はログ不要
    if (skippedEarly) {
      return false;
    }

    // 変更があった場合はログ
    if (context.implementedChanges && context.implementedChanges.length > 0) {
      return true;
    }

    // トラブルがあった場合はログ
    if (context.troubles && context.troubles.length > 0) {
      return true;
    }

    // 問題が検出された場合もログ
    if (context.issues && context.issues.length > 0) {
      return true;
    }

    return false;
  }

  /**
   * サイクルログを保存
   */
  saveLog(context: CycleContext, success: boolean, skippedEarly: boolean = false): string | null {
    if (!this.shouldLog(context, skippedEarly)) {
      logger.debug("Skipping cycle log - no significant work");
      return null;
    }

    const logData = this.buildLogData(context, success, skippedEarly);
    const markdown = this.formatMarkdown(logData);
    const filename = this.getFilename(logData);

    try {
      this.ensureLogDir();
      const filepath = join(LOG_DIR, filename);
      writeFileSync(filepath, markdown);
      logger.info("Cycle log saved", { filepath });
      return filepath;
    } catch (error) {
      logger.error("Failed to save cycle log", { error });
      return null;
    }
  }

  /**
   * ログデータを構築
   */
  private buildLogData(context: CycleContext, success: boolean, skippedEarly: boolean): CycleLogData {
    const endTime = new Date();
    const duration = endTime.getTime() - context.startTime.getTime();

    return {
      cycleId: context.cycleId,
      startTime: context.startTime,
      endTime,
      duration,
      success,
      skippedEarly,
      issuesDetected: (context.issues || []).map((i) => ({
        type: i.type,
        message: i.message,
        file: i.file,
      })),
      changesMade: (context.implementedChanges || []).map((c) => ({
        file: c.file,
        changeType: c.changeType,
      })),
      troubles: (context.troubles || []).map((t) => ({
        type: t.category,
        message: t.message,
      })),
      tokenUsage: context.tokenUsage
        ? {
            totalInput: context.tokenUsage.totalInput,
            totalOutput: context.tokenUsage.totalOutput,
          }
        : undefined,
    };
  }

  /**
   * Markdown形式でフォーマット
   */
  private formatMarkdown(data: CycleLogData): string {
    const lines: string[] = [];

    lines.push(`# Cycle Log: ${data.cycleId}`);
    lines.push("");
    lines.push("## Summary");
    lines.push(`- **Start Time**: ${data.startTime.toISOString()}`);
    lines.push(`- **End Time**: ${data.endTime.toISOString()}`);
    lines.push(`- **Duration**: ${(data.duration / 1000).toFixed(1)} seconds`);
    lines.push(`- **Status**: ${data.success ? "Success" : "Failure"}`);
    lines.push("");

    if (data.issuesDetected.length > 0) {
      lines.push("## Issues Detected");
      for (const issue of data.issuesDetected) {
        const location = issue.file ? ` @ ${issue.file}` : "";
        lines.push(`- [${issue.type}] ${issue.message}${location}`);
      }
      lines.push("");
    }

    if (data.changesMade.length > 0) {
      lines.push("## Changes Made");
      for (const change of data.changesMade) {
        lines.push(`- ${change.file}: ${change.changeType}`);
      }
      lines.push("");
    }

    if (data.troubles.length > 0) {
      lines.push("## Troubles Encountered");
      for (const trouble of data.troubles) {
        lines.push(`- [${trouble.type}] ${trouble.message}`);
      }
      lines.push("");
    }

    if (data.tokenUsage) {
      lines.push("## Token Usage");
      lines.push(`- **Total Input**: ${data.tokenUsage.totalInput.toLocaleString()} tokens`);
      lines.push(`- **Total Output**: ${data.tokenUsage.totalOutput.toLocaleString()} tokens`);
      lines.push("");
    }

    return lines.join("\n");
  }

  /**
   * ファイル名を生成
   */
  private getFilename(data: CycleLogData): string {
    const date = data.startTime.toISOString().split("T")[0];
    const shortId = data.cycleId.replace("cycle_", "").substring(0, 10);
    return `${date}-cycle-${shortId}.md`;
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
   * 指定日のサイクルログを取得
   */
  getCycleLogsForDate(date: string): CycleLogData[] {
    const logs: CycleLogData[] = [];

    if (!existsSync(LOG_DIR)) {
      return logs;
    }

    const files = readdirSync(LOG_DIR).filter(
      (f) => f.startsWith(date) && f.includes("-cycle-") && f.endsWith(".md")
    );

    for (const file of files) {
      try {
        const content = readFileSync(join(LOG_DIR, file), "utf-8");
        const parsed = this.parseLogFile(content);
        if (parsed) {
          logs.push(parsed);
        }
      } catch (error) {
        logger.warn("Failed to parse cycle log", { file, error });
      }
    }

    return logs;
  }

  /**
   * ログファイルをパース
   */
  private parseLogFile(content: string): CycleLogData | null {
    try {
      const lines = content.split("\n");

      // cycleIdを抽出
      const titleMatch = lines[0]?.match(/# Cycle Log: (.+)/);
      if (!titleMatch) return null;
      const cycleId = titleMatch[1];

      // Summary セクションをパース
      const startTimeMatch = content.match(/\*\*Start Time\*\*: (.+)/);
      const endTimeMatch = content.match(/\*\*End Time\*\*: (.+)/);
      const durationMatch = content.match(/\*\*Duration\*\*: ([\d.]+) seconds/);
      const statusMatch = content.match(/\*\*Status\*\*: (Success|Failure)/);

      const startTime = startTimeMatch ? new Date(startTimeMatch[1]) : new Date();
      const endTime = endTimeMatch ? new Date(endTimeMatch[1]) : new Date();
      const duration = durationMatch ? parseFloat(durationMatch[1]) * 1000 : 0;
      const success = statusMatch ? statusMatch[1] === "Success" : false;

      // 各セクションをパース
      const issuesDetected: Array<{ type: string; message: string; file?: string }> = [];
      const changesMade: Array<{ file: string; changeType: string }> = [];
      const troubles: Array<{ type: string; message: string }> = [];

      // Issues Detected セクション
      const issuesSection = content.match(/## Issues Detected\n([\s\S]*?)(?=\n##|$)/);
      if (issuesSection) {
        const issueLines = issuesSection[1].split("\n").filter((l) => l.startsWith("- "));
        for (const line of issueLines) {
          const match = line.match(/- \[(\w+)\] (.+?)(?:\s+@\s+(.+))?$/);
          if (match) {
            issuesDetected.push({
              type: match[1],
              message: match[2],
              file: match[3],
            });
          }
        }
      }

      // Changes Made セクション
      const changesSection = content.match(/## Changes Made\n([\s\S]*?)(?=\n##|$)/);
      if (changesSection) {
        const changeLines = changesSection[1].split("\n").filter((l) => l.startsWith("- "));
        for (const line of changeLines) {
          const match = line.match(/- (.+): (\w+)/);
          if (match) {
            changesMade.push({
              file: match[1],
              changeType: match[2],
            });
          }
        }
      }

      // Troubles セクション
      const troublesSection = content.match(/## Troubles Encountered\n([\s\S]*?)(?=\n##|$)/);
      if (troublesSection) {
        const troubleLines = troublesSection[1].split("\n").filter((l) => l.startsWith("- "));
        for (const line of troubleLines) {
          const match = line.match(/- \[(\w+)\] (.+)/);
          if (match) {
            troubles.push({
              type: match[1],
              message: match[2],
            });
          }
        }
      }

      // Token Usage セクション
      let tokenUsage: { totalInput: number; totalOutput: number } | undefined;
      const inputMatch = content.match(/\*\*Total Input\*\*: ([\d,]+) tokens/);
      const outputMatch = content.match(/\*\*Total Output\*\*: ([\d,]+) tokens/);
      if (inputMatch && outputMatch) {
        tokenUsage = {
          totalInput: parseInt(inputMatch[1].replace(/,/g, ""), 10),
          totalOutput: parseInt(outputMatch[1].replace(/,/g, ""), 10),
        };
      }

      return {
        cycleId,
        startTime,
        endTime,
        duration,
        success,
        skippedEarly: false,
        issuesDetected,
        changesMade,
        troubles,
        tokenUsage,
      };
    } catch {
      return null;
    }
  }
}

export const cycleLogger = new CycleLogger();
