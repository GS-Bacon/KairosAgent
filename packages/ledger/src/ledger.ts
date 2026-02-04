import {
  getLogger,
  generateId,
  formatDate,
  getMonthKey,
  sum,
  groupBy,
} from '@auto-claude/core';
import type { FinancialTransaction } from '@auto-claude/core';
import { readFileSync, writeFileSync, existsSync, mkdirSync, appendFileSync } from 'fs';
import { join } from 'path';

const logger = getLogger('ledger');

export interface LedgerConfig {
  ledgerDir: string;
  currency: string;
}

export interface LedgerSummary {
  period: string;
  totalIncome: number;
  totalExpense: number;
  totalInvestment: number;
  netProfit: number;
  byCategory: Record<string, number>;
  bySource: Record<string, number>;
  transactionCount: number;
}

export interface MonthlyGoal {
  month: string;
  targetIncome: number;
  currentIncome: number;
  progress: number;
  daysRemaining: number;
}

export class Ledger {
  private config: LedgerConfig;
  private transactions: FinancialTransaction[] = [];

  constructor(config: Partial<LedgerConfig> = {}) {
    this.config = {
      ledgerDir: config.ledgerDir ?? '/home/bacon/AutoClaudeKMP/workspace/ledger',
      currency: config.currency ?? 'JPY',
    };

    this.ensureLedgerDir();
    this.loadCurrentMonth();
    logger.info('Ledger initialized', { ledgerDir: this.config.ledgerDir });
  }

  private ensureLedgerDir(): void {
    if (!existsSync(this.config.ledgerDir)) {
      mkdirSync(this.config.ledgerDir, { recursive: true });
    }
  }

  private getLedgerFilePath(monthKey?: string): string {
    const key = monthKey ?? getMonthKey();
    return join(this.config.ledgerDir, `${key}.jsonl`);
  }

  private loadCurrentMonth(): void {
    const filePath = this.getLedgerFilePath();

    if (!existsSync(filePath)) {
      return;
    }

    try {
      const content = readFileSync(filePath, 'utf-8');
      const lines = content.trim().split('\n').filter(Boolean);

      this.transactions = lines.map((line) => {
        const tx = JSON.parse(line);
        tx.timestamp = new Date(tx.timestamp);
        return tx as FinancialTransaction;
      });

      logger.debug('Loaded transactions', { count: this.transactions.length });
    } catch (error) {
      logger.error('Failed to load ledger', { error });
    }
  }

  async recordTransaction(
    tx: Omit<FinancialTransaction, 'id' | 'timestamp' | 'currency'>
  ): Promise<FinancialTransaction> {
    const transaction: FinancialTransaction = {
      ...tx,
      id: generateId('tx'),
      timestamp: new Date(),
      currency: this.config.currency,
    };

    this.transactions.push(transaction);

    // ファイルに追記
    const filePath = this.getLedgerFilePath();
    const line = JSON.stringify(transaction) + '\n';

    try {
      appendFileSync(filePath, line, 'utf-8');
    } catch (error) {
      logger.error('Failed to write transaction', { error });
    }

    logger.info('Transaction recorded', {
      id: transaction.id,
      type: transaction.type,
      amount: transaction.amount,
      category: transaction.category,
    });

    return transaction;
  }

  async recordIncome(
    amount: number,
    category: string,
    description: string,
    source?: string
  ): Promise<FinancialTransaction> {
    return this.recordTransaction({
      type: 'income',
      amount,
      category,
      description,
      source,
    });
  }

  async recordExpense(
    amount: number,
    category: string,
    description: string,
    source?: string
  ): Promise<FinancialTransaction> {
    return this.recordTransaction({
      type: 'expense',
      amount,
      category,
      description,
      source,
    });
  }

  async recordInvestment(
    amount: number,
    category: string,
    description: string
  ): Promise<FinancialTransaction> {
    return this.recordTransaction({
      type: 'investment',
      amount,
      category,
      description,
    });
  }

  async getTransactionsForMonth(monthKey?: string): Promise<FinancialTransaction[]> {
    const key = monthKey ?? getMonthKey();

    if (key === getMonthKey()) {
      return [...this.transactions];
    }

    // 他の月のデータを読み込む
    const filePath = this.getLedgerFilePath(key);

    if (!existsSync(filePath)) {
      return [];
    }

    try {
      const content = readFileSync(filePath, 'utf-8');
      const lines = content.trim().split('\n').filter(Boolean);

      return lines.map((line) => {
        const tx = JSON.parse(line);
        tx.timestamp = new Date(tx.timestamp);
        return tx as FinancialTransaction;
      });
    } catch (error) {
      logger.error('Failed to load ledger for month', { monthKey: key, error });
      return [];
    }
  }

  async getSummary(monthKey?: string): Promise<LedgerSummary> {
    const transactions = await this.getTransactionsForMonth(monthKey);

    const income = transactions
      .filter((tx) => tx.type === 'income')
      .map((tx) => tx.amount);

    const expense = transactions
      .filter((tx) => tx.type === 'expense')
      .map((tx) => tx.amount);

    const investment = transactions
      .filter((tx) => tx.type === 'investment')
      .map((tx) => tx.amount);

    const totalIncome = sum(income);
    const totalExpense = sum(expense);
    const totalInvestment = sum(investment);

    const byCategory: Record<string, number> = {};
    for (const tx of transactions) {
      const sign = tx.type === 'income' ? 1 : -1;
      byCategory[tx.category] = (byCategory[tx.category] ?? 0) + tx.amount * sign;
    }

    const bySource: Record<string, number> = {};
    for (const tx of transactions) {
      if (tx.source) {
        const sign = tx.type === 'income' ? 1 : -1;
        bySource[tx.source] = (bySource[tx.source] ?? 0) + tx.amount * sign;
      }
    }

    return {
      period: monthKey ?? getMonthKey(),
      totalIncome,
      totalExpense,
      totalInvestment,
      netProfit: totalIncome - totalExpense - totalInvestment,
      byCategory,
      bySource,
      transactionCount: transactions.length,
    };
  }

  async getMonthlyGoal(targetIncome: number): Promise<MonthlyGoal> {
    const now = new Date();
    const monthKey = getMonthKey(now);
    const summary = await this.getSummary(monthKey);

    const daysInMonth = new Date(now.getFullYear(), now.getMonth() + 1, 0).getDate();
    const currentDay = now.getDate();
    const daysRemaining = daysInMonth - currentDay;

    return {
      month: monthKey,
      targetIncome,
      currentIncome: summary.totalIncome,
      progress: (summary.totalIncome / targetIncome) * 100,
      daysRemaining,
    };
  }

  getRecentTransactions(count: number = 10): FinancialTransaction[] {
    return this.transactions.slice(-count);
  }

  async getTotalIncome(): Promise<number> {
    // TODO: 全期間の収入を計算
    const summary = await this.getSummary();
    return summary.totalIncome;
  }

  async getTotalExpense(): Promise<number> {
    const summary = await this.getSummary();
    return summary.totalExpense;
  }

  async exportToMarkdown(monthKey?: string): Promise<string> {
    const summary = await this.getSummary(monthKey);
    const transactions = await this.getTransactionsForMonth(monthKey);

    let md = `# 収支レポート - ${summary.period}\n\n`;

    md += `## サマリー\n`;
    md += `- 収入: ¥${summary.totalIncome.toLocaleString()}\n`;
    md += `- 支出: ¥${summary.totalExpense.toLocaleString()}\n`;
    md += `- 投資: ¥${summary.totalInvestment.toLocaleString()}\n`;
    md += `- 純利益: ¥${summary.netProfit.toLocaleString()}\n\n`;

    md += `## カテゴリ別\n`;
    for (const [category, amount] of Object.entries(summary.byCategory)) {
      const sign = amount >= 0 ? '+' : '';
      md += `- ${category}: ${sign}¥${amount.toLocaleString()}\n`;
    }
    md += '\n';

    if (Object.keys(summary.bySource).length > 0) {
      md += `## ソース別\n`;
      for (const [source, amount] of Object.entries(summary.bySource)) {
        const sign = amount >= 0 ? '+' : '';
        md += `- ${source}: ${sign}¥${amount.toLocaleString()}\n`;
      }
      md += '\n';
    }

    md += `## 取引履歴\n\n`;
    md += `| 日時 | タイプ | カテゴリ | 金額 | 説明 |\n`;
    md += `|------|--------|----------|------|------|\n`;

    for (const tx of transactions) {
      const date = formatDate(tx.timestamp);
      const sign = tx.type === 'income' ? '+' : '-';
      md += `| ${date} | ${tx.type} | ${tx.category} | ${sign}¥${tx.amount.toLocaleString()} | ${tx.description} |\n`;
    }

    return md;
  }
}

let instance: Ledger | null = null;

export function getLedger(config?: Partial<LedgerConfig>): Ledger {
  if (!instance) {
    instance = new Ledger(config);
  }
  return instance;
}
