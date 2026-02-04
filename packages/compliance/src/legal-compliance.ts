import { getLogger, getMonthKey, formatDate } from '@auto-claude/core';
import { getLedger } from '@auto-claude/ledger';

const logger = getLogger('compliance:legal');

export interface TaxCalculation {
  grossIncome: number;
  expenses: number;
  taxableIncome: number;
  taxRate: number;
  estimatedTax: number;
  notes: string[];
}

export interface TOSCheckResult {
  platform: string;
  action: string;
  compliant: boolean;
  violations: string[];
  recommendations: string[];
}

export interface IncomeReport {
  month: string;
  totalIncome: number;
  totalExpenses: number;
  netProfit: number;
  byCategory: Record<string, number>;
  taxEstimate: TaxCalculation;
}

export class LegalCompliance {
  private ledger = getLedger();

  constructor() {
    logger.info('LegalCompliance initialized');
  }

  async calculateTax(income: number): Promise<TaxCalculation> {
    // 雑所得として計算
    const taxableIncome = income;

    // 必要経費の計算
    const expenses = await this.calculateExpenses();

    // 所得税率の適用（累進課税）
    const netIncome = taxableIncome - expenses;
    const taxRate = this.getTaxRate(netIncome);
    const estimatedTax = netIncome > 0 ? netIncome * taxRate : 0;

    return {
      grossIncome: income,
      expenses,
      taxableIncome: netIncome,
      taxRate,
      estimatedTax,
      notes: [
        '※雑所得として計算',
        '※20万円以下は確定申告不要（給与所得者の場合）',
        '※住民税は別途申告が必要な場合があります',
        '※正確な計算は税理士に相談してください',
      ],
    };
  }

  private async calculateExpenses(): Promise<number> {
    const summary = await this.ledger.getSummary();
    return summary.totalExpense + summary.totalInvestment;
  }

  private getTaxRate(income: number): number {
    // 日本の所得税率（簡略化）
    if (income <= 1950000) return 0.05;
    if (income <= 3300000) return 0.10;
    if (income <= 6950000) return 0.20;
    if (income <= 9000000) return 0.23;
    if (income <= 18000000) return 0.33;
    if (income <= 40000000) return 0.40;
    return 0.45;
  }

  async checkTermsOfService(
    platform: string,
    action: string
  ): Promise<TOSCheckResult> {
    const violations = this.detectViolations(platform, action);

    return {
      platform,
      action,
      compliant: violations.length === 0,
      violations,
      recommendations:
        violations.length > 0 ? this.suggestAlternatives(violations) : [],
    };
  }

  private detectViolations(platform: string, action: string): string[] {
    const violations: string[] = [];
    const actionLower = action.toLowerCase();

    // 一般的な規約違反パターン
    const commonViolations: Record<string, string[]> = {
      spam: ['大量送信', 'スパム', '自動投稿', 'bulk'],
      scraping: ['スクレイピング', 'クローリング', 'データ収集'],
      impersonation: ['なりすまし', '偽装', 'fake'],
      automation: ['自動化', 'bot', 'スクリプト'],
    };

    // プラットフォーム固有のチェック
    const platformRules: Record<string, string[]> = {
      twitter: ['自動フォロー', '自動いいね', 'API制限'],
      youtube: ['視聴回数水増し', 'クリックファーム'],
      amazon: ['レビュー操作', '在庫操作'],
      fiverr: ['外部取引', '連絡先交換'],
    };

    for (const [category, keywords] of Object.entries(commonViolations)) {
      if (keywords.some((kw) => actionLower.includes(kw.toLowerCase()))) {
        violations.push(`${category}に該当する可能性があります`);
      }
    }

    const platformLower = platform.toLowerCase();
    if (platformRules[platformLower]) {
      for (const rule of platformRules[platformLower]) {
        if (actionLower.includes(rule.toLowerCase())) {
          violations.push(`${platform}の規約: ${rule}`);
        }
      }
    }

    return violations;
  }

  private suggestAlternatives(violations: string[]): string[] {
    const suggestions: string[] = [];

    if (violations.some((v) => v.includes('spam'))) {
      suggestions.push('手動での投稿または適切な間隔を空けた投稿を推奨');
    }

    if (violations.some((v) => v.includes('automation'))) {
      suggestions.push('プラットフォーム公式のAPIを使用するか、手動操作を検討');
    }

    if (violations.some((v) => v.includes('scraping'))) {
      suggestions.push('公式APIまたはデータ提供サービスの利用を推奨');
    }

    return suggestions;
  }

  async generateIncomeReport(monthKey?: string): Promise<IncomeReport> {
    const key = monthKey ?? getMonthKey();
    const summary = await this.ledger.getSummary(key);
    const taxEstimate = await this.calculateTax(summary.totalIncome);

    return {
      month: key,
      totalIncome: summary.totalIncome,
      totalExpenses: summary.totalExpense + summary.totalInvestment,
      netProfit: summary.netProfit,
      byCategory: summary.byCategory,
      taxEstimate,
    };
  }

  async exportAnnualReport(year: number): Promise<string> {
    let totalIncome = 0;
    let totalExpenses = 0;
    const monthlyData: Array<{
      month: string;
      income: number;
      expenses: number;
    }> = [];

    for (let month = 1; month <= 12; month++) {
      const monthKey = `${year}-${String(month).padStart(2, '0')}`;
      try {
        const summary = await this.ledger.getSummary(monthKey);
        totalIncome += summary.totalIncome;
        totalExpenses += summary.totalExpense + summary.totalInvestment;
        monthlyData.push({
          month: monthKey,
          income: summary.totalIncome,
          expenses: summary.totalExpense + summary.totalInvestment,
        });
      } catch {
        // 月のデータがない場合はスキップ
      }
    }

    const taxCalc = await this.calculateTax(totalIncome);

    return `# ${year}年 収益レポート

## 年間サマリー
- 総収入: ¥${totalIncome.toLocaleString()}
- 総経費: ¥${totalExpenses.toLocaleString()}
- 純利益: ¥${(totalIncome - totalExpenses).toLocaleString()}

## 税金見積もり
- 課税所得: ¥${taxCalc.taxableIncome.toLocaleString()}
- 税率: ${(taxCalc.taxRate * 100).toFixed(0)}%
- 推定税額: ¥${taxCalc.estimatedTax.toLocaleString()}

${taxCalc.notes.join('\n')}

## 月別詳細
| 月 | 収入 | 経費 | 純利益 |
|---|---|---|---|
${monthlyData.map((m) => `| ${m.month} | ¥${m.income.toLocaleString()} | ¥${m.expenses.toLocaleString()} | ¥${(m.income - m.expenses).toLocaleString()} |`).join('\n')}
`;
  }
}

let instance: LegalCompliance | null = null;

export function getLegalCompliance(): LegalCompliance {
  if (!instance) {
    instance = new LegalCompliance();
  }
  return instance;
}
