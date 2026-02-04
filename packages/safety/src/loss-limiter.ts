import { getLogger } from '@auto-claude/core';
import type { FinancialTransaction } from '@auto-claude/core';

const logger = getLogger('safety:loss-limiter');

export interface LossLimiterConfig {
  maxLossJPY: number;
  warningThresholdPercent: number;
  checkIntervalMs: number;
}

export interface LossStatus {
  currentLoss: number;
  maxLoss: number;
  remaining: number;
  percentUsed: number;
  isWarning: boolean;
  isBlocked: boolean;
}

export class LossLimiter {
  private config: LossLimiterConfig;
  private totalLoss: number = 0;
  private transactions: FinancialTransaction[] = [];

  constructor(config: Partial<LossLimiterConfig> = {}) {
    this.config = {
      maxLossJPY: config.maxLossJPY ?? 30000,
      warningThresholdPercent: config.warningThresholdPercent ?? 80,
      checkIntervalMs: config.checkIntervalMs ?? 60000,
    };
    logger.info('LossLimiter initialized', { maxLoss: this.config.maxLossJPY });
  }

  recordTransaction(transaction: FinancialTransaction): void {
    this.transactions.push(transaction);

    if (transaction.type === 'expense' || transaction.type === 'investment') {
      this.totalLoss += transaction.amount;
      logger.info('Expense recorded', {
        amount: transaction.amount,
        totalLoss: this.totalLoss,
      });
    } else if (transaction.type === 'income') {
      // 収入は損失から差し引く（稼いだ分は再投資可能）
      this.totalLoss = Math.max(0, this.totalLoss - transaction.amount);
      logger.info('Income recorded', {
        amount: transaction.amount,
        totalLoss: this.totalLoss,
      });
    }
  }

  getStatus(): LossStatus {
    const remaining = Math.max(0, this.config.maxLossJPY - this.totalLoss);
    const percentUsed = (this.totalLoss / this.config.maxLossJPY) * 100;

    return {
      currentLoss: this.totalLoss,
      maxLoss: this.config.maxLossJPY,
      remaining,
      percentUsed,
      isWarning: percentUsed >= this.config.warningThresholdPercent,
      isBlocked: this.totalLoss >= this.config.maxLossJPY,
    };
  }

  canSpend(amount: number): boolean {
    const afterSpend = this.totalLoss + amount;
    return afterSpend <= this.config.maxLossJPY;
  }

  checkAndWarn(): LossStatus {
    const status = this.getStatus();

    if (status.isBlocked) {
      logger.critical('Loss limit reached! All spending blocked.', status);
    } else if (status.isWarning) {
      logger.warn('Approaching loss limit', status);
    }

    return status;
  }

  reset(): void {
    this.totalLoss = 0;
    this.transactions = [];
    logger.info('LossLimiter reset');
  }

  getTransactions(): FinancialTransaction[] {
    return [...this.transactions];
  }
}

let instance: LossLimiter | null = null;

export function getLossLimiter(config?: Partial<LossLimiterConfig>): LossLimiter {
  if (!instance) {
    instance = new LossLimiter(config);
  }
  return instance;
}
