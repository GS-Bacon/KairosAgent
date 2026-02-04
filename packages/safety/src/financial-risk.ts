import { RiskLevel, getLogger } from '@auto-claude/core';

const logger = getLogger('safety:financial-risk');

export interface FinancialRiskAssessment {
  riskLevel: RiskLevel;
  score: number;
  factors: RiskFactor[];
  recommendation: string;
  approved: boolean;
}

export interface RiskFactor {
  name: string;
  weight: number;
  score: number;
  description: string;
}

export interface FinancialAction {
  type: 'spend' | 'invest' | 'withdraw' | 'transfer';
  amount: number;
  currency: string;
  platform?: string;
  description: string;
  isRecurring?: boolean;
  metadata?: Record<string, unknown>;
}

export class FinancialRiskAssessor {
  private riskThresholds = {
    low: 25,
    medium: 50,
    high: 75,
  };

  assessRisk(action: FinancialAction): FinancialRiskAssessment {
    const factors = this.calculateFactors(action);
    const score = this.calculateScore(factors);
    const riskLevel = this.determineRiskLevel(score);
    const recommendation = this.generateRecommendation(action, riskLevel, factors);

    const assessment: FinancialRiskAssessment = {
      riskLevel,
      score,
      factors,
      recommendation,
      approved: riskLevel <= RiskLevel.MEDIUM,
    };

    logger.info('Financial risk assessed', {
      action: action.description,
      amount: action.amount,
      riskLevel,
      score,
    });

    return assessment;
  }

  private calculateFactors(action: FinancialAction): RiskFactor[] {
    const factors: RiskFactor[] = [];

    // 金額リスク
    const amountScore = this.assessAmountRisk(action.amount);
    factors.push({
      name: 'amount',
      weight: 0.4,
      score: amountScore,
      description: `金額: ¥${action.amount.toLocaleString()}`,
    });

    // プラットフォームリスク
    const platformScore = this.assessPlatformRisk(action.platform);
    factors.push({
      name: 'platform',
      weight: 0.2,
      score: platformScore,
      description: `プラットフォーム: ${action.platform || '不明'}`,
    });

    // 取引タイプリスク
    const typeScore = this.assessTypeRisk(action.type);
    factors.push({
      name: 'type',
      weight: 0.2,
      score: typeScore,
      description: `取引タイプ: ${action.type}`,
    });

    // 繰り返しリスク
    const recurringScore = action.isRecurring ? 60 : 20;
    factors.push({
      name: 'recurring',
      weight: 0.2,
      score: recurringScore,
      description: action.isRecurring ? '定期的な支出' : '一回限りの支出',
    });

    return factors;
  }

  private assessAmountRisk(amount: number): number {
    if (amount <= 1000) return 10;
    if (amount <= 5000) return 30;
    if (amount <= 10000) return 50;
    if (amount <= 20000) return 70;
    return 90;
  }

  private assessPlatformRisk(platform?: string): number {
    if (!platform) return 70;

    const trustedPlatforms = ['amazon', 'paypal', 'stripe', 'wise'];
    const moderatePlatforms = ['fiverr', 'upwork', 'coconala'];
    const lowercasePlatform = platform.toLowerCase();

    if (trustedPlatforms.some((p) => lowercasePlatform.includes(p))) {
      return 20;
    }
    if (moderatePlatforms.some((p) => lowercasePlatform.includes(p))) {
      return 40;
    }
    return 60;
  }

  private assessTypeRisk(type: FinancialAction['type']): number {
    switch (type) {
      case 'spend':
        return 30;
      case 'invest':
        return 60;
      case 'withdraw':
        return 40;
      case 'transfer':
        return 50;
      default:
        return 50;
    }
  }

  private calculateScore(factors: RiskFactor[]): number {
    return factors.reduce((total, factor) => total + factor.score * factor.weight, 0);
  }

  private determineRiskLevel(score: number): RiskLevel {
    if (score < this.riskThresholds.low) return RiskLevel.LOW;
    if (score < this.riskThresholds.medium) return RiskLevel.MEDIUM;
    if (score < this.riskThresholds.high) return RiskLevel.HIGH;
    return RiskLevel.CRITICAL;
  }

  private generateRecommendation(
    action: FinancialAction,
    riskLevel: RiskLevel,
    factors: RiskFactor[]
  ): string {
    const highRiskFactors = factors.filter((f) => f.score >= 60);

    if (riskLevel === RiskLevel.LOW) {
      return '低リスク: 自動承認可能';
    }

    if (riskLevel === RiskLevel.MEDIUM) {
      return `中リスク: 承認推奨。注意点: ${highRiskFactors.map((f) => f.name).join(', ')}`;
    }

    if (riskLevel === RiskLevel.HIGH) {
      return `高リスク: 人間の承認必須。リスク要因: ${highRiskFactors.map((f) => f.description).join('; ')}`;
    }

    return `重大リスク: 実行を推奨しません。金額: ¥${action.amount}`;
  }
}

let instance: FinancialRiskAssessor | null = null;

export function getFinancialRiskAssessor(): FinancialRiskAssessor {
  if (!instance) {
    instance = new FinancialRiskAssessor();
  }
  return instance;
}
