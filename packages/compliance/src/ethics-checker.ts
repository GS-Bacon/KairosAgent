import { getLogger } from '@auto-claude/core';
import { getClaudeCLI } from '@auto-claude/ai-router';

const logger = getLogger('compliance:ethics');

export interface EthicsCheckResult {
  allowed: boolean;
  reason?: string;
  severity: 'allowed' | 'warning' | 'blocked';
  category?: string;
}

export class EthicsChecker {
  private blacklist = [
    // 災害・デマ
    '災害デマ',
    'フェイクニュース',
    '虚偽情報',

    // 詐欺
    '詐欺',
    'scam',
    'フィッシング',
    'ポンジ',

    // 反社会的
    '反社',
    'yakuza',
    '暴力団',

    // 違法
    '違法薬物',
    'ドラッグ',
    '武器売買',

    // 有害
    '児童ポルノ',
    'child exploitation',
  ];

  private graylist = [
    // グレーゾーン（警告のみ）
    'アフィリエイト',
    '転売',
    '副業',
  ];

  constructor() {
    logger.info('EthicsChecker initialized');
  }

  async checkContent(content: string): Promise<EthicsCheckResult> {
    const contentLower = content.toLowerCase();

    // ブラックリストチェック
    for (const term of this.blacklist) {
      if (contentLower.includes(term.toLowerCase())) {
        logger.warn('Blacklisted content detected', { term });
        return {
          allowed: false,
          reason: `禁止ワード「${term}」が含まれています`,
          severity: 'blocked',
          category: 'blacklist',
        };
      }
    }

    // グレーリストチェック
    for (const term of this.graylist) {
      if (contentLower.includes(term.toLowerCase())) {
        logger.info('Graylist content detected', { term });
        return {
          allowed: true,
          reason: `注意: 「${term}」を含むコンテンツです。規約違反に注意してください。`,
          severity: 'warning',
          category: 'graylist',
        };
      }
    }

    return {
      allowed: true,
      severity: 'allowed',
    };
  }

  async checkStrategy(strategyDescription: string): Promise<EthicsCheckResult> {
    // 基本チェック
    const basicCheck = await this.checkContent(strategyDescription);
    if (!basicCheck.allowed) {
      return basicCheck;
    }

    // 倫理的な問題がないかAIで詳細チェック
    const claudeCLI = getClaudeCLI();

    try {
      const result = await claudeCLI.executeTask({
        prompt: `以下の収益化戦略が倫理的に問題ないか評価してください。

戦略:
${strategyDescription}

以下の基準で評価:
1. 詐欺や虚偽広告に該当しないか
2. プラットフォームの規約に違反しないか
3. 他者に実害を与えないか
4. 法的に問題ないか

回答形式（JSON）:
{
  "allowed": true/false,
  "reason": "理由",
  "severity": "allowed" | "warning" | "blocked",
  "category": "カテゴリ（fraud, tos_violation, harm, legal）"
}

JSONのみ返してください。`,
        allowedTools: [],
        timeout: 60000,
      });

      if (result.success) {
        const jsonMatch = result.output.match(/\{[\s\S]*\}/);
        if (jsonMatch) {
          const analysis = JSON.parse(jsonMatch[0]) as EthicsCheckResult;
          return analysis;
        }
      }
    } catch (error) {
      logger.error('Ethics analysis failed', { error });
    }

    // 分析に失敗した場合は警告付きで許可
    return {
      allowed: true,
      reason: '詳細な倫理チェックができませんでした。慎重に進めてください。',
      severity: 'warning',
    };
  }

  isBlacklisted(term: string): boolean {
    return this.blacklist.some((b) => b.toLowerCase() === term.toLowerCase());
  }

  addToBlacklist(term: string): void {
    if (!this.blacklist.includes(term)) {
      this.blacklist.push(term);
      logger.info('Added to blacklist', { term });
    }
  }

  removeFromBlacklist(term: string): void {
    const index = this.blacklist.indexOf(term);
    if (index !== -1) {
      this.blacklist.splice(index, 1);
      logger.info('Removed from blacklist', { term });
    }
  }
}

let instance: EthicsChecker | null = null;

export function getEthicsChecker(): EthicsChecker {
  if (!instance) {
    instance = new EthicsChecker();
  }
  return instance;
}
