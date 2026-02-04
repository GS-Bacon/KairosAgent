import {
  getLogger,
  type DailyReport,
  type WeeklyReport,
  type DailyReportActivities,
  type DailyReportFinancials,
  type WeeklyReportTotals,
  type AuditEntry,
  type FinancialTransaction,
} from '@auto-claude/core';
import { getAuditLogger } from '@auto-claude/audit';
import { getLedger } from '@auto-claude/ledger';
import { existsSync, mkdirSync, readFileSync, writeFileSync, readdirSync } from 'fs';
import { join } from 'path';

const logger = getLogger('report-generator');

export interface ReportGeneratorConfig {
  reportsDir: string;
}

export class ReportGenerator {
  private config: ReportGeneratorConfig;
  private dailyDir: string;
  private weeklyDir: string;

  constructor(config: Partial<ReportGeneratorConfig> = {}) {
    this.config = {
      reportsDir: config.reportsDir ?? '/home/bacon/AutoClaudeKMP/workspace/reports',
    };

    this.dailyDir = join(this.config.reportsDir, 'daily');
    this.weeklyDir = join(this.config.reportsDir, 'weekly');

    this.ensureDirectories();
    logger.info('ReportGenerator initialized', { reportsDir: this.config.reportsDir });
  }

  private ensureDirectories(): void {
    if (!existsSync(this.dailyDir)) {
      mkdirSync(this.dailyDir, { recursive: true });
    }
    if (!existsSync(this.weeklyDir)) {
      mkdirSync(this.weeklyDir, { recursive: true });
    }
  }

  async generateDailyReport(date?: string): Promise<DailyReport> {
    const targetDate = date ?? new Date().toISOString().slice(0, 10);
    logger.info('Generating daily report', { date: targetDate });

    const auditLogger = getAuditLogger();
    const ledger = getLedger();

    // 監査ログからアクティビティ情報を収集
    const entries = await auditLogger.getEntriesForMonth();
    const dayEntries = entries.filter(
      (e: AuditEntry) => new Date(e.timestamp).toISOString().slice(0, 10) === targetDate
    );

    // タスク完了数をカウント
    const tasksCompleted = dayEntries.filter(
      (e: AuditEntry) => e.actionType === 'task_complete' || e.actionType === 'task_completed'
    ).length;

    // 戦略実行数をカウント
    const strategiesRun = dayEntries.filter(
      (e: AuditEntry) => e.actionType === 'strategy_execute' || e.actionType === 'strategy_run'
    ).length;

    // 提案処理数をカウント
    const suggestionsProcessed = dayEntries.filter(
      (e: AuditEntry) => e.actionType === 'suggestion_respond' || e.actionType === 'suggestion_processed'
    ).length;

    // 財務情報を取得
    const dayTransactions = (await ledger.getTransactionsForMonth()).filter(
      (t: FinancialTransaction) => new Date(t.timestamp).toISOString().slice(0, 10) === targetDate
    );

    const dayIncome = dayTransactions
      .filter((t: FinancialTransaction) => t.type === 'income')
      .reduce((sum: number, t: FinancialTransaction) => sum + t.amount, 0);
    const dayExpense = dayTransactions
      .filter((t: FinancialTransaction) => t.type === 'expense')
      .reduce((sum: number, t: FinancialTransaction) => sum + Math.abs(t.amount), 0);

    // 達成事項・失敗・改善点を抽出
    const accomplishments: string[] = [];
    const failures: string[] = [];
    const improvements: string[] = [];

    // 成功したアクションを達成事項に
    const successActions = dayEntries.filter((e: AuditEntry) => e.success);
    const uniqueTypes = [...new Set(successActions.map((e: AuditEntry) => e.actionType))];
    for (const type of uniqueTypes.slice(0, 5)) {
      const count = successActions.filter((e: AuditEntry) => e.actionType === type).length;
      accomplishments.push(`${type}: ${count}回実行`);
    }

    // 失敗したアクションを失敗に
    const failedActions = dayEntries.filter((e: AuditEntry) => !e.success && e.error);
    for (const action of failedActions.slice(0, 5)) {
      failures.push(`${action.actionType}: ${action.error}`);
    }

    // ヘルス状態を取得
    const healthStatus = dayEntries.some((e: AuditEntry) => e.actionType === 'health_check' && !e.success)
      ? '一部問題あり'
      : '正常';

    const activities: DailyReportActivities = {
      tasksCompleted,
      strategiesRun,
      suggestionsProcessed,
    };

    const financials: DailyReportFinancials = {
      income: dayIncome,
      expense: dayExpense,
      net: dayIncome - dayExpense,
    };

    const report: DailyReport = {
      date: targetDate,
      generatedAt: new Date(),
      summary: `${targetDate}の活動: タスク${tasksCompleted}件完了、戦略${strategiesRun}回実行`,
      activities,
      accomplishments,
      failures,
      improvements,
      financials,
      healthStatus,
    };

    // 保存
    const filePath = join(this.dailyDir, `${targetDate}.json`);
    writeFileSync(filePath, JSON.stringify(report, null, 2), 'utf-8');
    logger.info('Daily report saved', { path: filePath });

    return report;
  }

  async generateWeeklyReport(weekString?: string): Promise<WeeklyReport> {
    // 週の計算 (ISO週番号)
    const now = new Date();
    const week = weekString ?? this.getISOWeek(now);
    const { startDate, endDate } = this.getWeekDates(week);

    logger.info('Generating weekly report', { week, startDate, endDate });

    // 該当週の日報を収集
    const dailyReports: DailyReport[] = [];
    const dailyIds: string[] = [];

    let current = new Date(startDate);
    while (current <= new Date(endDate)) {
      const dateStr = current.toISOString().slice(0, 10);
      const report = await this.getDailyReport(dateStr);
      if (report) {
        dailyReports.push(report);
        dailyIds.push(dateStr);
      }
      current.setDate(current.getDate() + 1);
    }

    // 集計
    const totals: WeeklyReportTotals = {
      tasksCompleted: dailyReports.reduce((sum, r) => sum + r.activities.tasksCompleted, 0),
      strategiesRun: dailyReports.reduce((sum, r) => sum + r.activities.strategiesRun, 0),
      suggestionsProcessed: dailyReports.reduce(
        (sum, r) => sum + r.activities.suggestionsProcessed,
        0
      ),
      income: dailyReports.reduce((sum, r) => sum + r.financials.income, 0),
      expense: dailyReports.reduce((sum, r) => sum + r.financials.expense, 0),
      net: dailyReports.reduce((sum, r) => sum + r.financials.net, 0),
    };

    // ハイライト・課題・学びを収集
    const highlights: string[] = [];
    const challenges: string[] = [];
    const learnings: string[] = [];

    for (const report of dailyReports) {
      if (report.accomplishments.length > 0) {
        highlights.push(...report.accomplishments.slice(0, 2));
      }
      if (report.failures.length > 0) {
        challenges.push(...report.failures.slice(0, 2));
      }
      if (report.improvements.length > 0) {
        learnings.push(...report.improvements.slice(0, 2));
      }
    }

    const weeklyReport: WeeklyReport = {
      week,
      startDate,
      endDate,
      generatedAt: new Date(),
      summary: `${week}週: タスク${totals.tasksCompleted}件完了、純収益¥${totals.net.toLocaleString()}`,
      totals,
      highlights: [...new Set(highlights)].slice(0, 10),
      challenges: [...new Set(challenges)].slice(0, 10),
      learnings: [...new Set(learnings)].slice(0, 10),
      dailyReports: dailyIds,
    };

    // 保存
    const filePath = join(this.weeklyDir, `${week}.json`);
    writeFileSync(filePath, JSON.stringify(weeklyReport, null, 2), 'utf-8');
    logger.info('Weekly report saved', { path: filePath });

    return weeklyReport;
  }

  async getDailyReport(date: string): Promise<DailyReport | null> {
    const filePath = join(this.dailyDir, `${date}.json`);
    if (!existsSync(filePath)) {
      return null;
    }

    try {
      const content = readFileSync(filePath, 'utf-8');
      const report = JSON.parse(content) as DailyReport;
      report.generatedAt = new Date(report.generatedAt);
      return report;
    } catch (error) {
      logger.error('Failed to read daily report', { date, error });
      return null;
    }
  }

  async getWeeklyReport(week: string): Promise<WeeklyReport | null> {
    const filePath = join(this.weeklyDir, `${week}.json`);
    if (!existsSync(filePath)) {
      return null;
    }

    try {
      const content = readFileSync(filePath, 'utf-8');
      const report = JSON.parse(content) as WeeklyReport;
      report.generatedAt = new Date(report.generatedAt);
      return report;
    } catch (error) {
      logger.error('Failed to read weekly report', { week, error });
      return null;
    }
  }

  async listDailyReports(limit: number = 7): Promise<DailyReport[]> {
    if (!existsSync(this.dailyDir)) {
      return [];
    }

    const files = readdirSync(this.dailyDir)
      .filter((f) => f.endsWith('.json'))
      .sort()
      .reverse()
      .slice(0, limit);

    const reports: DailyReport[] = [];
    for (const file of files) {
      const date = file.replace('.json', '');
      const report = await this.getDailyReport(date);
      if (report) {
        reports.push(report);
      }
    }

    return reports;
  }

  async listWeeklyReports(limit: number = 4): Promise<WeeklyReport[]> {
    if (!existsSync(this.weeklyDir)) {
      return [];
    }

    const files = readdirSync(this.weeklyDir)
      .filter((f) => f.endsWith('.json'))
      .sort()
      .reverse()
      .slice(0, limit);

    const reports: WeeklyReport[] = [];
    for (const file of files) {
      const week = file.replace('.json', '');
      const report = await this.getWeeklyReport(week);
      if (report) {
        reports.push(report);
      }
    }

    return reports;
  }

  private getISOWeek(date: Date): string {
    const d = new Date(Date.UTC(date.getFullYear(), date.getMonth(), date.getDate()));
    const dayNum = d.getUTCDay() || 7;
    d.setUTCDate(d.getUTCDate() + 4 - dayNum);
    const yearStart = new Date(Date.UTC(d.getUTCFullYear(), 0, 1));
    const weekNum = Math.ceil(((d.getTime() - yearStart.getTime()) / 86400000 + 1) / 7);
    return `${d.getUTCFullYear()}-W${weekNum.toString().padStart(2, '0')}`;
  }

  private getWeekDates(week: string): { startDate: string; endDate: string } {
    const [yearStr, weekStr] = week.split('-W');
    const year = parseInt(yearStr, 10);
    const weekNum = parseInt(weekStr, 10);

    // ISO週の開始日（月曜日）を計算
    const jan4 = new Date(year, 0, 4);
    const jan4DayOfWeek = jan4.getDay() || 7;
    const firstMonday = new Date(jan4);
    firstMonday.setDate(jan4.getDate() - jan4DayOfWeek + 1);

    const startDate = new Date(firstMonday);
    startDate.setDate(firstMonday.getDate() + (weekNum - 1) * 7);

    const endDate = new Date(startDate);
    endDate.setDate(startDate.getDate() + 6);

    return {
      startDate: startDate.toISOString().slice(0, 10),
      endDate: endDate.toISOString().slice(0, 10),
    };
  }
}

let instance: ReportGenerator | null = null;

export function getReportGenerator(config?: Partial<ReportGeneratorConfig>): ReportGenerator {
  if (!instance) {
    instance = new ReportGenerator(config);
  }
  return instance;
}
