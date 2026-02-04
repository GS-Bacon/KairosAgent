import { getLogger } from '@auto-claude/core';
import { getDiscordNotifier } from '@auto-claude/notification';
import { Strategy, StrategyType, StrategyStatus, getStrategyManager } from './strategy-manager.js';
import { BaseExecutor, ExecutionResult } from './executors/base-executor.js';
import { AffiliateExecutor } from './executors/affiliate-executor.js';
import { FreelanceExecutor } from './executors/freelance-executor.js';
import { DigitalProductExecutor } from './executors/digital-product-executor.js';
import { existsSync, readFileSync, writeFileSync, mkdirSync } from 'fs';
import { join, dirname } from 'path';

const logger = getLogger('strategy-executor');

const EXECUTION_HISTORY_PATH = '/home/bacon/AutoClaudeKMP/workspace/execution-history.json';

export class StrategyExecutor {
  private executors: BaseExecutor[] = [];
  private discord = getDiscordNotifier();
  private strategyManager = getStrategyManager();
  private executionHistory: Map<string, ExecutionResult[]> = new Map();

  constructor() {
    // 利用可能なExecutorを登録
    this.registerExecutor(new AffiliateExecutor());
    this.registerExecutor(new FreelanceExecutor());
    this.registerExecutor(new DigitalProductExecutor());

    // 実行履歴を読み込み
    this.loadExecutionHistory();

    logger.info('StrategyExecutor initialized', {
      executorCount: this.executors.length,
      supportedTypes: this.getSupportedTypes(),
    });
  }

  private loadExecutionHistory(): void {
    try {
      if (existsSync(EXECUTION_HISTORY_PATH)) {
        const content = readFileSync(EXECUTION_HISTORY_PATH, 'utf-8');
        const data = JSON.parse(content) as Record<string, ExecutionResult[]>;

        for (const [strategyId, results] of Object.entries(data)) {
          this.executionHistory.set(strategyId, results);
        }

        logger.info('Execution history loaded', {
          strategiesCount: this.executionHistory.size,
        });
      }
    } catch (error) {
      logger.warn('Failed to load execution history', { error });
    }
  }

  private saveExecutionHistory(): void {
    try {
      const dir = dirname(EXECUTION_HISTORY_PATH);
      if (!existsSync(dir)) {
        mkdirSync(dir, { recursive: true });
      }

      const data: Record<string, ExecutionResult[]> = {};
      for (const [strategyId, results] of this.executionHistory.entries()) {
        // 直近20件のみ保存（メモリ節約）
        data[strategyId] = results.slice(-20);
      }

      writeFileSync(EXECUTION_HISTORY_PATH, JSON.stringify(data, null, 2), 'utf-8');
      logger.debug('Execution history saved');
    } catch (error) {
      logger.error('Failed to save execution history', { error });
    }
  }

  registerExecutor(executor: BaseExecutor): void {
    this.executors.push(executor);
    logger.info('Executor registered', {
      supportedTypes: executor.supportedTypes,
    });
  }

  getSupportedTypes(): StrategyType[] {
    const types = new Set<StrategyType>();
    for (const executor of this.executors) {
      for (const type of executor.supportedTypes) {
        types.add(type);
      }
    }
    return Array.from(types);
  }

  findExecutor(strategy: Strategy): BaseExecutor | undefined {
    return this.executors.find((e) => e.canExecute(strategy));
  }

  async executeStrategy(strategy: Strategy): Promise<ExecutionResult> {
    logger.info('Executing strategy', {
      id: strategy.id,
      name: strategy.name,
      type: strategy.type,
    });

    // 適切なExecutorを探す
    const executor = this.findExecutor(strategy);

    if (!executor) {
      const error = `No executor found for strategy type: ${strategy.type}`;
      logger.error(error, { strategyId: strategy.id });

      return {
        strategyId: strategy.id,
        success: false,
        stepResults: [],
        totalRevenue: 0,
        totalCost: 0,
        summary: error,
      };
    }

    // 実行
    const result = await executor.execute(strategy);

    // 結果を記録
    await this.strategyManager.recordExecution(strategy.id, {
      success: result.success,
      revenue: result.totalRevenue,
      cost: result.totalCost,
    });

    // 実行履歴に追加して永続化
    const history = this.executionHistory.get(strategy.id) || [];
    history.push(result);
    this.executionHistory.set(strategy.id, history);
    this.saveExecutionHistory();

    // 3回連続失敗チェック
    await this.checkConsecutiveFailures(strategy);

    // 通知
    if (result.success) {
      if (result.totalRevenue > 0) {
        await this.discord.sendSuccess(
          '戦略実行完了',
          `${strategy.name}: ${result.summary}\n収益: ¥${result.totalRevenue}`
        );
      }
    } else {
      await this.discord.sendWarning(
        '戦略実行失敗',
        `${strategy.name}: ${result.summary}`
      );
    }

    return result;
  }

  async executeAllActive(): Promise<Map<string, ExecutionResult>> {
    const activeStrategies = this.strategyManager.getActiveStrategies();
    const results = new Map<string, ExecutionResult>();

    if (activeStrategies.length === 0) {
      logger.info('No active strategies to execute');
      return results;
    }

    logger.info('Executing all active strategies', {
      count: activeStrategies.length,
    });

    for (const strategy of activeStrategies) {
      const result = await this.executeStrategy(strategy);
      results.set(strategy.id, result);
    }

    // サマリー通知
    const successCount = Array.from(results.values()).filter((r) => r.success).length;
    const totalRevenue = Array.from(results.values()).reduce(
      (sum, r) => sum + r.totalRevenue,
      0
    );

    if (activeStrategies.length > 1) {
      await this.discord.sendInfo(
        '戦略実行サイクル完了',
        `${successCount}/${activeStrategies.length}戦略成功\n総収益: ¥${totalRevenue}`
      );
    }

    return results;
  }

  private async checkConsecutiveFailures(strategy: Strategy): Promise<void> {
    const history = this.executionHistory.get(strategy.id) || [];
    const recentResults = history.slice(-3);

    if (recentResults.length >= 3 && recentResults.every((r) => !r.success)) {
      logger.warn('Strategy has 3 consecutive failures, auto-pausing', {
        strategyId: strategy.id,
        strategyName: strategy.name,
      });

      await this.strategyManager.deactivateStrategy(
        strategy.id,
        '3回連続失敗により自動停止'
      );

      await this.discord.sendCritical({
        title: '戦略自動停止',
        description: `${strategy.name} が3回連続で失敗したため自動停止しました。\n確認・修正後に再アクティベートしてください。`,
      });
    }
  }

  getExecutionHistory(strategyId: string): ExecutionResult[] {
    return this.executionHistory.get(strategyId) || [];
  }

  clearExecutionHistory(strategyId?: string): void {
    if (strategyId) {
      this.executionHistory.delete(strategyId);
    } else {
      this.executionHistory.clear();
    }
  }
}

let instance: StrategyExecutor | null = null;

export function getStrategyExecutor(): StrategyExecutor {
  if (!instance) {
    instance = new StrategyExecutor();
  }
  return instance;
}
