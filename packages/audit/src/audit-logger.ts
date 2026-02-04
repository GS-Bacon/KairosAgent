import {
  RiskLevel,
  getLogger,
  generateId,
  formatDate,
  getMonthKey,
  groupBy,
  sum,
} from '@auto-claude/core';
import type { AuditEntry } from '@auto-claude/core';
import { appendFileSync, readFileSync, existsSync, mkdirSync, writeFileSync } from 'fs';
import { dirname, join } from 'path';

const logger = getLogger('audit');

export interface AuditConfig {
  logDir: string;
  maxEntriesInMemory: number;
}

export interface AuditReport {
  period: string;
  totalActions: number;
  byType: Record<string, number>;
  byRisk: Record<string, number>;
  byActor: Record<string, number>;
  financialSummary: {
    totalIncome: number;
    totalExpense: number;
    netProfit: number;
  };
  failureRate: number;
  approvalStats: {
    total: number;
    approved: number;
    rejected: number;
    autoApproved: number;
  };
}

export class AuditLogger {
  private config: AuditConfig;
  private recentEntries: AuditEntry[] = [];

  constructor(config: Partial<AuditConfig> = {}) {
    this.config = {
      logDir: config.logDir ?? '/home/bacon/AutoClaudeKMP/workspace/audit',
      maxEntriesInMemory: config.maxEntriesInMemory ?? 1000,
    };

    this.ensureLogDir();
    logger.info('AuditLogger initialized', { logDir: this.config.logDir });
  }

  private ensureLogDir(): void {
    if (!existsSync(this.config.logDir)) {
      mkdirSync(this.config.logDir, { recursive: true });
    }
  }

  private getLogFilePath(): string {
    const monthKey = getMonthKey();
    return join(this.config.logDir, `audit-${monthKey}.jsonl`);
  }

  async log(
    entry: Omit<AuditEntry, 'timestamp' | 'actionId'>
  ): Promise<string> {
    const fullEntry: AuditEntry = {
      ...entry,
      timestamp: new Date(),
      actionId: generateId('audit'),
    };

    // メモリに追加
    this.recentEntries.push(fullEntry);
    if (this.recentEntries.length > this.config.maxEntriesInMemory) {
      this.recentEntries.shift();
    }

    // ファイルに追記
    await this.appendToLog(fullEntry);

    // 高リスクアクションはログ出力
    if (entry.riskLevel >= RiskLevel.HIGH) {
      logger.warn('High risk action recorded', {
        actionId: fullEntry.actionId,
        type: entry.actionType,
        description: entry.description,
      });
    }

    return fullEntry.actionId;
  }

  private async appendToLog(entry: AuditEntry): Promise<void> {
    const logFile = this.getLogFilePath();
    const line = JSON.stringify(entry) + '\n';

    try {
      appendFileSync(logFile, line, 'utf-8');
    } catch (error) {
      logger.error('Failed to write audit log', { error });
    }
  }

  async getEntriesForMonth(monthKey?: string): Promise<AuditEntry[]> {
    const key = monthKey ?? getMonthKey();
    const logFile = join(this.config.logDir, `audit-${key}.jsonl`);

    if (!existsSync(logFile)) {
      return [];
    }

    try {
      const content = readFileSync(logFile, 'utf-8');
      const lines = content.trim().split('\n').filter(Boolean);

      return lines.map((line) => {
        const entry = JSON.parse(line);
        entry.timestamp = new Date(entry.timestamp);
        return entry as AuditEntry;
      });
    } catch (error) {
      logger.error('Failed to read audit log', { error, monthKey: key });
      return [];
    }
  }

  async generateMonthlyReport(monthKey?: string): Promise<AuditReport> {
    const entries = await this.getEntriesForMonth(monthKey);

    const byType = this.countBy(entries, (e) => e.actionType);
    const byRisk = this.countBy(entries, (e) => `risk_${e.riskLevel}`);
    const byActor = this.countBy(entries, (e) => e.actor);

    const financialEntries = entries.filter(
      (e) => e.financialImpact !== undefined
    );
    const income = financialEntries
      .filter((e) => (e.financialImpact ?? 0) > 0)
      .map((e) => e.financialImpact ?? 0);
    const expense = financialEntries
      .filter((e) => (e.financialImpact ?? 0) < 0)
      .map((e) => Math.abs(e.financialImpact ?? 0));

    const approvedEntries = entries.filter((e) => e.approved);
    const rejectedEntries = entries.filter(
      (e) => !e.approved && e.riskLevel >= RiskLevel.HIGH
    );
    const autoApprovedEntries = entries.filter(
      (e) => e.approved && e.riskLevel <= RiskLevel.LOW && !e.approvedBy
    );

    const failedEntries = entries.filter((e) => !e.success);

    return {
      period: monthKey ?? getMonthKey(),
      totalActions: entries.length,
      byType,
      byRisk,
      byActor,
      financialSummary: {
        totalIncome: sum(income),
        totalExpense: sum(expense),
        netProfit: sum(income) - sum(expense),
      },
      failureRate: entries.length > 0 ? failedEntries.length / entries.length : 0,
      approvalStats: {
        total: entries.length,
        approved: approvedEntries.length,
        rejected: rejectedEntries.length,
        autoApproved: autoApprovedEntries.length,
      },
    };
  }

  private countBy<T>(items: T[], keyFn: (item: T) => string): Record<string, number> {
    const result: Record<string, number> = {};
    for (const item of items) {
      const key = keyFn(item);
      result[key] = (result[key] ?? 0) + 1;
    }
    return result;
  }

  getRecentEntries(count: number = 100): AuditEntry[] {
    return this.recentEntries.slice(-count);
  }

  async getRecent(limit: number): Promise<AuditEntry[]> {
    // まずメモリ内のエントリをチェック
    if (this.recentEntries.length >= limit) {
      return this.recentEntries.slice(-limit);
    }

    // メモリ内が不足している場合、今日のログファイルから読み込む
    const today = new Date().toISOString().slice(0, 10); // YYYY-MM-DD
    const monthKey = today.slice(0, 7); // YYYY-MM
    const logFile = join(this.config.logDir, `audit-${monthKey}.jsonl`);

    if (!existsSync(logFile)) {
      return this.recentEntries.slice(-limit);
    }

    try {
      const content = readFileSync(logFile, 'utf-8');
      const lines = content.trim().split('\n').filter(Boolean);

      // 最新N件を取得
      const recentLines = lines.slice(-limit);
      const entries = recentLines.map((line) => {
        const entry = JSON.parse(line);
        entry.timestamp = new Date(entry.timestamp);
        return entry as AuditEntry;
      });

      return entries;
    } catch (error) {
      logger.error('Failed to read recent audit entries', { error });
      return this.recentEntries.slice(-limit);
    }
  }

  async searchEntries(query: {
    actionType?: string;
    actor?: string;
    minRiskLevel?: RiskLevel;
    startDate?: Date;
    endDate?: Date;
    limit?: number;
  }): Promise<AuditEntry[]> {
    const entries = await this.getEntriesForMonth();
    let filtered = entries;

    if (query.actionType) {
      filtered = filtered.filter((e) => e.actionType === query.actionType);
    }

    if (query.actor) {
      filtered = filtered.filter((e) => e.actor === query.actor);
    }

    if (query.minRiskLevel !== undefined) {
      filtered = filtered.filter((e) => e.riskLevel >= query.minRiskLevel!);
    }

    if (query.startDate) {
      filtered = filtered.filter((e) => e.timestamp >= query.startDate!);
    }

    if (query.endDate) {
      filtered = filtered.filter((e) => e.timestamp <= query.endDate!);
    }

    if (query.limit) {
      filtered = filtered.slice(-query.limit);
    }

    return filtered;
  }

  async exportToMarkdown(monthKey?: string): Promise<string> {
    const report = await this.generateMonthlyReport(monthKey);

    return `# 監査レポート - ${report.period}

## 概要
- 総アクション数: ${report.totalActions}
- 失敗率: ${(report.failureRate * 100).toFixed(1)}%

## アクションタイプ別
${Object.entries(report.byType)
  .map(([type, count]) => `- ${type}: ${count}`)
  .join('\n')}

## リスクレベル別
${Object.entries(report.byRisk)
  .map(([risk, count]) => `- ${risk}: ${count}`)
  .join('\n')}

## 実行者別
${Object.entries(report.byActor)
  .map(([actor, count]) => `- ${actor}: ${count}`)
  .join('\n')}

## 財務サマリー
- 収入: ¥${report.financialSummary.totalIncome.toLocaleString()}
- 支出: ¥${report.financialSummary.totalExpense.toLocaleString()}
- 純利益: ¥${report.financialSummary.netProfit.toLocaleString()}

## 承認統計
- 総数: ${report.approvalStats.total}
- 承認: ${report.approvalStats.approved}
- 拒否: ${report.approvalStats.rejected}
- 自動承認: ${report.approvalStats.autoApproved}
`;
  }
}

let instance: AuditLogger | null = null;

export function getAuditLogger(config?: Partial<AuditConfig>): AuditLogger {
  if (!instance) {
    instance = new AuditLogger(config);
  }
  return instance;
}
