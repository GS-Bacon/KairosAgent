import { RiskLevel, getLogger, generateId } from '@auto-claude/core';
import { getEthicsChecker } from '@auto-claude/compliance';
import { getApprovalGate, getDiscordNotifier } from '@auto-claude/notification';
import { readFileSync, writeFileSync, existsSync, mkdirSync, readdirSync } from 'fs';
import { join } from 'path';

const logger = getLogger('strategies');

export interface Strategy {
  id: string;
  name: string;
  description: string;
  type: StrategyType;
  status: StrategyStatus;
  expectedRevenue: number;
  expectedCost: number;
  riskLevel: RiskLevel;
  createdAt: Date;
  activatedAt?: Date;
  deactivatedAt?: Date;
  performance: StrategyPerformance;
  config: Record<string, unknown>;
}

export enum StrategyType {
  AFFILIATE = 'affiliate',
  FREELANCE = 'freelance',
  DIGITAL_PRODUCT = 'digital_product',
  CONTENT_CREATION = 'content_creation',
  OTHER = 'other',
}

export enum StrategyStatus {
  DRAFT = 'draft',
  PENDING_APPROVAL = 'pending_approval',
  ACTIVE = 'active',
  PAUSED = 'paused',
  COMPLETED = 'completed',
  FAILED = 'failed',
}

export interface StrategyPerformance {
  totalRevenue: number;
  totalCost: number;
  executionCount: number;
  successCount: number;
  failureCount: number;
  lastExecutedAt?: Date;
  roi: number;
}

export interface StrategyConfig {
  strategiesDir: string;
  maxActiveStrategies: number;
}

export class StrategyManager {
  private config: StrategyConfig;
  private strategies: Map<string, Strategy> = new Map();
  private ethicsChecker = getEthicsChecker();
  private approvalGate = getApprovalGate();
  private discord = getDiscordNotifier();

  constructor(config: Partial<StrategyConfig> = {}) {
    this.config = {
      strategiesDir: config.strategiesDir ?? '/home/bacon/AutoClaudeKMP/workspace/strategies',
      maxActiveStrategies: config.maxActiveStrategies ?? 5,
    };

    this.ensureDirectories();
    this.loadStrategies();
    logger.info('StrategyManager initialized', { strategiesDir: this.config.strategiesDir });
  }

  private ensureDirectories(): void {
    if (!existsSync(this.config.strategiesDir)) {
      mkdirSync(this.config.strategiesDir, { recursive: true });
    }
  }

  private loadStrategies(): void {
    try {
      const files = readdirSync(this.config.strategiesDir).filter((f) =>
        f.endsWith('.json')
      );

      for (const file of files) {
        const path = join(this.config.strategiesDir, file);
        const content = readFileSync(path, 'utf-8');
        const strategy = JSON.parse(content) as Strategy;

        // 日付フィールドの変換
        strategy.createdAt = new Date(strategy.createdAt);
        if (strategy.activatedAt) strategy.activatedAt = new Date(strategy.activatedAt);
        if (strategy.deactivatedAt) strategy.deactivatedAt = new Date(strategy.deactivatedAt);
        if (strategy.performance.lastExecutedAt) {
          strategy.performance.lastExecutedAt = new Date(strategy.performance.lastExecutedAt);
        }

        this.strategies.set(strategy.id, strategy);
      }

      logger.info('Strategies loaded', { count: this.strategies.size });
    } catch (error) {
      logger.error('Failed to load strategies', { error });
    }
  }

  private saveStrategy(strategy: Strategy): void {
    const path = join(this.config.strategiesDir, `${strategy.id}.json`);
    writeFileSync(path, JSON.stringify(strategy, null, 2), 'utf-8');
  }

  async createStrategy(
    input: Omit<Strategy, 'id' | 'createdAt' | 'status' | 'performance'>
  ): Promise<Strategy> {
    // 倫理チェック
    const ethicsResult = await this.ethicsChecker.checkStrategy(
      `${input.name}: ${input.description}`
    );

    if (!ethicsResult.allowed) {
      throw new Error(`Strategy rejected: ${ethicsResult.reason}`);
    }

    const strategy: Strategy = {
      ...input,
      id: generateId('strat'),
      createdAt: new Date(),
      status: StrategyStatus.DRAFT,
      performance: {
        totalRevenue: 0,
        totalCost: 0,
        executionCount: 0,
        successCount: 0,
        failureCount: 0,
        roi: 0,
      },
    };

    this.strategies.set(strategy.id, strategy);
    this.saveStrategy(strategy);

    logger.info('Strategy created', { id: strategy.id, name: strategy.name });

    return strategy;
  }

  async activateStrategy(strategyId: string): Promise<boolean> {
    const strategy = this.strategies.get(strategyId);

    if (!strategy) {
      throw new Error(`Strategy not found: ${strategyId}`);
    }

    // アクティブ戦略数のチェック
    const activeCount = this.getActiveStrategies().length;
    if (activeCount >= this.config.maxActiveStrategies) {
      await this.discord.sendWarning(
        '戦略制限',
        `アクティブ戦略数が上限（${this.config.maxActiveStrategies}）に達しています`
      );
      return false;
    }

    // 承認リクエスト
    if (strategy.riskLevel >= RiskLevel.MEDIUM) {
      strategy.status = StrategyStatus.PENDING_APPROVAL;
      this.saveStrategy(strategy);

      const approved = await this.approvalGate.requestApproval({
        type: 'strategy',
        title: `戦略承認: ${strategy.name}`,
        description: strategy.description,
        riskLevel: strategy.riskLevel,
      });

      if (!approved) {
        logger.info('Strategy activation awaiting approval', { id: strategyId });
        return false;
      }
    }

    strategy.status = StrategyStatus.ACTIVE;
    strategy.activatedAt = new Date();
    this.saveStrategy(strategy);

    await this.discord.sendSuccess(
      '戦略アクティブ化',
      `${strategy.name} がアクティブになりました`
    );

    logger.info('Strategy activated', { id: strategyId });
    return true;
  }

  async deactivateStrategy(strategyId: string, reason?: string): Promise<void> {
    const strategy = this.strategies.get(strategyId);

    if (!strategy) {
      throw new Error(`Strategy not found: ${strategyId}`);
    }

    strategy.status = StrategyStatus.PAUSED;
    strategy.deactivatedAt = new Date();
    this.saveStrategy(strategy);

    await this.discord.sendInfo(
      '戦略停止',
      `${strategy.name} を停止しました${reason ? `: ${reason}` : ''}`
    );

    logger.info('Strategy deactivated', { id: strategyId, reason });
  }

  async recordExecution(
    strategyId: string,
    result: {
      success: boolean;
      revenue: number;
      cost: number;
    }
  ): Promise<void> {
    const strategy = this.strategies.get(strategyId);

    if (!strategy) {
      throw new Error(`Strategy not found: ${strategyId}`);
    }

    strategy.performance.executionCount++;
    strategy.performance.totalRevenue += result.revenue;
    strategy.performance.totalCost += result.cost;
    strategy.performance.lastExecutedAt = new Date();

    if (result.success) {
      strategy.performance.successCount++;
    } else {
      strategy.performance.failureCount++;
    }

    // ROI計算
    if (strategy.performance.totalCost > 0) {
      strategy.performance.roi =
        ((strategy.performance.totalRevenue - strategy.performance.totalCost) /
          strategy.performance.totalCost) *
        100;
    }

    this.saveStrategy(strategy);

    logger.info('Strategy execution recorded', {
      id: strategyId,
      success: result.success,
      revenue: result.revenue,
      cost: result.cost,
    });
  }

  getStrategy(strategyId: string): Strategy | undefined {
    return this.strategies.get(strategyId);
  }

  getAllStrategies(): Strategy[] {
    return Array.from(this.strategies.values());
  }

  getActiveStrategies(): Strategy[] {
    return this.getAllStrategies().filter((s) => s.status === StrategyStatus.ACTIVE);
  }

  getBestPerformingStrategies(limit: number = 5): Strategy[] {
    return this.getAllStrategies()
      .filter((s) => s.performance.executionCount > 0)
      .sort((a, b) => b.performance.roi - a.performance.roi)
      .slice(0, limit);
  }

  async evaluateStrategies(): Promise<void> {
    const active = this.getActiveStrategies();

    for (const strategy of active) {
      // 失敗率が高い戦略を警告
      const failureRate =
        strategy.performance.failureCount / strategy.performance.executionCount;

      if (failureRate > 0.5 && strategy.performance.executionCount >= 5) {
        await this.discord.sendWarning(
          '戦略パフォーマンス低下',
          `${strategy.name} の失敗率が ${(failureRate * 100).toFixed(0)}% に達しています`
        );
      }

      // ROIがマイナスの戦略を警告
      if (strategy.performance.roi < -20 && strategy.performance.executionCount >= 10) {
        await this.discord.sendWarning(
          '戦略ROI低下',
          `${strategy.name} のROIが ${strategy.performance.roi.toFixed(0)}% です。見直しを検討してください。`
        );
      }
    }
  }
}

let instance: StrategyManager | null = null;

export function getStrategyManager(config?: Partial<StrategyConfig>): StrategyManager {
  if (!instance) {
    instance = new StrategyManager(config);
  }
  return instance;
}
