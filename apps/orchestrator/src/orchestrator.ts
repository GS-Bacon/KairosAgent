import { SystemState, getLogger, ensureDirectories, getConfig } from '@auto-claude/core';
import { getLossLimiter, getBoundaryGuard, getResourceManager } from '@auto-claude/safety';
import { getBackupManager } from '@auto-claude/backup';
import { getAuditLogger } from '@auto-claude/audit';
import { getDiscordNotifier, getApprovalGate, getSuggestionGate } from '@auto-claude/notification';
import { getMemoryManager } from '@auto-claude/memory';
import { getLedger } from '@auto-claude/ledger';
import { getTaskQueue } from '@auto-claude/ai-router';
import { getLearningCycleManager, getReportGenerator } from '@auto-claude/self-improve';
import { getStrategyManager } from '@auto-claude/strategies';
import { getGitHubManager } from '@auto-claude/github';
import { Scheduler } from './scheduler.js';
import { HeartbeatManager } from './heartbeat.js';

const logger = getLogger('orchestrator');
const config = getConfig();

export interface OrchestratorState {
  status: 'starting' | 'running' | 'stopping' | 'stopped';
  systemState: SystemState;
  startedAt?: Date;
  stoppedAt?: Date;
}

export class Orchestrator {
  private state: OrchestratorState = {
    status: 'stopped',
    systemState: SystemState.STOPPED,
  };

  private scheduler: Scheduler;
  private heartbeat: HeartbeatManager;
  private shutdownHandlers: Array<() => Promise<void>> = [];

  // サービス
  private lossLimiter = getLossLimiter();
  private boundaryGuard = getBoundaryGuard();
  private resourceManager = getResourceManager();
  private backupManager = getBackupManager();
  private auditLogger = getAuditLogger();
  private discord = getDiscordNotifier({ webhookUrl: config.discord.webhookUrl });
  private approvalGate = getApprovalGate();
  private memory = getMemoryManager();
  private ledger = getLedger();
  private taskQueue = getTaskQueue();
  private learningCycle = getLearningCycleManager();
  private strategyManager = getStrategyManager();
  private githubManager = getGitHubManager();
  private suggestionGate = getSuggestionGate();
  private reportGenerator = getReportGenerator();

  constructor() {
    this.scheduler = new Scheduler();
    this.heartbeat = new HeartbeatManager();
    logger.info('Orchestrator created');
  }

  async start(): Promise<void> {
    if (this.state.status === 'running') {
      logger.warn('Orchestrator already running');
      return;
    }

    this.state.status = 'starting';
    logger.info('Starting orchestrator...');

    try {
      // ディレクトリの確保
      ensureDirectories();

      // .gitignore の確保
      await this.githubManager.ensureGitignore();

      // スケジュールタスクの登録
      this.registerScheduledTasks();

      // シャットダウンハンドラの設定
      this.setupShutdownHandlers();

      // スケジューラ開始
      this.scheduler.start();

      this.state.status = 'running';
      this.state.systemState = SystemState.HEALTHY;
      this.state.startedAt = new Date();

      // 監査ログ
      await this.auditLogger.log({
        actionType: 'system_start',
        description: 'Orchestrator started',
        actor: 'system',
        riskLevel: 1,
        approved: true,
        success: true,
      });

      // Discord通知
      await this.discord.sendSuccess('システム起動', 'AutoClaudeKMP が起動しました');

      logger.info('Orchestrator started successfully');
    } catch (error) {
      this.state.status = 'stopped';
      this.state.systemState = SystemState.STOPPED;
      logger.error('Failed to start orchestrator', { error });
      throw error;
    }
  }

  private registerScheduledTasks(): void {
    // ヘルスチェック（5分ごと）
    this.scheduler.registerTask({
      id: 'health_check',
      name: 'ヘルスチェック',
      intervalMs: 5 * 60 * 1000,
      enabled: true,
      handler: async () => {
        await this.heartbeat.beat();
        // スケジューラステータスを保存（ダッシュボード用）
        await this.scheduler.saveStatus(this.memory);
      },
    });

    // ハートビート（30分ごと）
    this.scheduler.registerTask({
      id: 'heartbeat',
      name: 'ハートビート通知',
      intervalMs: 30 * 60 * 1000,
      enabled: true,
      handler: async () => {
        const status = await this.heartbeat.beat();
        await this.discord.sendInfo(
          'ハートビート',
          `稼働時間: ${Math.floor(status.uptime / 60)}分, 状態: ${status.health.state}`
        );

        // 提案の処理
        await this.processPendingSuggestions();
      },
    });

    // 日次バックアップ（毎日3時）
    this.scheduler.registerTask({
      id: 'daily_backup',
      name: '日次バックアップ',
      cronExpression: '0 3 * * *',
      enabled: true,
      handler: async () => {
        await this.backupManager.dailyBackup();
      },
    });

    // 日次分析（毎日6時）
    this.scheduler.registerTask({
      id: 'daily_analysis',
      name: '日次分析',
      cronExpression: '0 6 * * *',
      enabled: true,
      handler: async () => {
        // 学習サイクルレビュー
        await this.learningCycle.dailyReview();

        // 戦略評価
        await this.strategyManager.evaluateStrategies();

        // 日報生成
        const yesterday = new Date();
        yesterday.setDate(yesterday.getDate() - 1);
        const yesterdayStr = yesterday.toISOString().slice(0, 10);
        await this.reportGenerator.generateDailyReport(yesterdayStr);

        // 収支サマリー
        const summary = await this.ledger.getSummary();
        await this.discord.sendInfo(
          '日次レポート',
          `今月の収益: ¥${summary.totalIncome.toLocaleString()}, 支出: ¥${summary.totalExpense.toLocaleString()}`
        );
      },
    });

    // 週報生成（毎週月曜6時）
    this.scheduler.registerTask({
      id: 'weekly_report',
      name: '週報生成',
      cronExpression: '0 6 * * 1',
      enabled: true,
      handler: async () => {
        // 先週の週報を生成
        const lastWeek = new Date();
        lastWeek.setDate(lastWeek.getDate() - 7);
        const report = await this.reportGenerator.generateWeeklyReport();

        await this.discord.sendInfo(
          '週報',
          `${report.week}: タスク${report.totals.tasksCompleted}件完了, 純収益¥${report.totals.net.toLocaleString()}`
        );
      },
    });

    // 承認リクエストクリーンアップ（1時間ごと）
    this.scheduler.registerTask({
      id: 'approval_cleanup',
      name: '承認リクエストクリーンアップ',
      intervalMs: 60 * 60 * 1000,
      enabled: true,
      handler: async () => {
        this.approvalGate.cleanupExpired();
      },
    });

    // リソース監視（5分ごと）
    this.scheduler.registerTask({
      id: 'resource_monitor',
      name: 'リソース監視',
      intervalMs: 5 * 60 * 1000,
      enabled: true,
      handler: async () => {
        this.resourceManager.adjustByTime();
        await this.resourceManager.checkResources();
      },
    });

    // 損失チェック（10分ごと）
    this.scheduler.registerTask({
      id: 'loss_check',
      name: '損失チェック',
      intervalMs: 10 * 60 * 1000,
      enabled: true,
      handler: async () => {
        const status = this.lossLimiter.checkAndWarn();
        if (status.isBlocked) {
          await this.discord.sendCritical({
            title: '損失制限到達',
            description: '全ての支出がブロックされています',
          });
        }
      },
    });
  }

  private setupShutdownHandlers(): void {
    const shutdown = async (signal: string) => {
      logger.info(`Received ${signal}, shutting down...`);
      await this.stop();
      process.exit(0);
    };

    process.on('SIGINT', () => shutdown('SIGINT'));
    process.on('SIGTERM', () => shutdown('SIGTERM'));

    process.on('uncaughtException', async (error) => {
      logger.critical('Uncaught exception', { error: error.message, stack: error.stack });
      await this.discord.sendCritical({
        title: '未捕捉例外',
        description: error.message,
      });

      // 問題として登録
      await this.learningCycle.registerProblem({
        type: 'error',
        description: `未捕捉例外: ${error.message}`,
        context: { stack: error.stack },
        severity: 4,
      });
    });

    process.on('unhandledRejection', async (reason) => {
      const message = reason instanceof Error ? reason.message : String(reason);
      logger.error('Unhandled rejection', { reason: message });

      await this.learningCycle.registerProblem({
        type: 'error',
        description: `未処理のPromise拒否: ${message}`,
        context: {},
        severity: 3,
      });
    });
  }

  async stop(): Promise<void> {
    if (this.state.status === 'stopped') {
      return;
    }

    this.state.status = 'stopping';
    logger.info('Stopping orchestrator...');

    // スケジューラ停止
    this.scheduler.stop();

    // タスクキューをクリア
    this.taskQueue.clear();

    // シャットダウンハンドラを実行
    for (const handler of this.shutdownHandlers) {
      try {
        await handler();
      } catch (error) {
        logger.error('Shutdown handler error', { error });
      }
    }

    // 監査ログ
    await this.auditLogger.log({
      actionType: 'system_stop',
      description: 'Orchestrator stopped',
      actor: 'system',
      riskLevel: 1,
      approved: true,
      success: true,
    });

    await this.discord.sendInfo('システム停止', 'AutoClaudeKMP が停止しました');

    this.state.status = 'stopped';
    this.state.systemState = SystemState.STOPPED;
    this.state.stoppedAt = new Date();

    logger.info('Orchestrator stopped');
  }

  onShutdown(handler: () => Promise<void>): void {
    this.shutdownHandlers.push(handler);
  }

  getState(): OrchestratorState {
    return { ...this.state };
  }

  getScheduler(): Scheduler {
    return this.scheduler;
  }

  getHeartbeat(): HeartbeatManager {
    return this.heartbeat;
  }

  private async processPendingSuggestions(): Promise<void> {
    const pendingSuggestions = this.suggestionGate.getPending();

    if (pendingSuggestions.length === 0) {
      return;
    }

    logger.info('Processing pending suggestions', { count: pendingSuggestions.length });

    for (const suggestion of pendingSuggestions) {
      try {
        // 提案を分析して判断（シンプルな自動判断ロジック）
        const analysis = this.analyzeSuggestion(suggestion);

        // 応答を記録
        this.suggestionGate.respond(
          suggestion.id,
          {
            analysis: analysis.analysis,
            decision: analysis.decision,
            actionPlan: analysis.actionPlan,
          },
          analysis.status
        );

        // Discord通知（回答時のみ）
        await this.discord.sendInfo(
          '提案への回答',
          `「${suggestion.title}」に回答しました: ${analysis.decision}`
        );

        // 監査ログ
        await this.auditLogger.log({
          actionType: 'suggestion_respond',
          description: `Responded to suggestion: ${suggestion.title}`,
          actor: 'ai',
          riskLevel: 1,
          approved: true,
          success: true,
        });
      } catch (error) {
        logger.error('Failed to process suggestion', { id: suggestion.id, error });
      }
    }
  }

  private analyzeSuggestion(suggestion: { title: string; content: string; category: string; priority: string }): {
    analysis: string;
    decision: string;
    actionPlan?: string;
    status: 'accepted' | 'rejected' | 'deferred';
  } {
    // 基本的な自動判断ロジック
    // 実際のプロダクションではAIを使った詳細な分析を行う

    const { category, priority, title, content } = suggestion;

    // バグ報告は優先的に採択
    if (category === 'bug') {
      return {
        analysis: `バグ報告として受け付けました。内容: ${content.slice(0, 100)}...`,
        decision: '調査を開始します',
        actionPlan: '次回のメンテナンスで対応予定',
        status: 'accepted',
      };
    }

    // 高優先度は採択
    if (priority === 'high') {
      return {
        analysis: `高優先度の提案として受け付けました。`,
        decision: '優先的に検討します',
        actionPlan: '詳細な実装計画を作成中',
        status: 'accepted',
      };
    }

    // 質問は回答して保留
    if (category === 'question') {
      return {
        analysis: `ご質問を確認しました。`,
        decision: '確認して回答いたします',
        status: 'deferred',
      };
    }

    // その他は検討の上保留
    return {
      analysis: `提案を受け付けました。カテゴリ: ${category}, 優先度: ${priority}`,
      decision: '検討の結果、保留とさせていただきます。リソースに余裕ができ次第対応を検討します。',
      status: 'deferred',
    };
  }
}

let instance: Orchestrator | null = null;

export function getOrchestrator(): Orchestrator {
  if (!instance) {
    instance = new Orchestrator();
  }
  return instance;
}
