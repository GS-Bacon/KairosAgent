import { SystemState, WorkPhase, getLogger, ensureDirectories, getConfig, getRateLimitManager, type Suggestion } from '@auto-claude/core';
import { getLossLimiter, getBoundaryGuard, getResourceManager } from '@auto-claude/safety';
import { getBackupManager } from '@auto-claude/backup';
import { getAuditLogger } from '@auto-claude/audit';
import { getDiscordNotifier, getApprovalGate, getSuggestionGate } from '@auto-claude/notification';
import { getMemoryManager } from '@auto-claude/memory';
import { getLedger } from '@auto-claude/ledger';
import { getTaskQueue, getClaudeCLI } from '@auto-claude/ai-router';
import {
  getLearningCycleManager,
  getReportGenerator,
  getAutoImprover,
  getSystemDiagnostician,
  getRetrospectiveAnalyzer,
  getPatternExtractor,
  getDocSyncChecker,
} from '@auto-claude/self-improve';
import { getStrategyManager, getStrategyActivator, getStrategyExecutor } from '@auto-claude/strategies';
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
  private strategyActivator = getStrategyActivator();
  private strategyExecutor = getStrategyExecutor();
  private autoImprover = getAutoImprover();
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

      // レートリミット通知コールバックを設定
      getRateLimitManager().setNotificationCallback(async (isActive, details) => {
        await this.discord.sendRateLimitAlert(isActive, details);
      });

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

      // 起動時に初回タスクを実行（非同期で遅延実行）
      setTimeout(() => this.runInitialTasks(), 3000);
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
      requiresClaude: false,
      handler: async () => {
        await this.heartbeat.beat();
        // スケジューラステータスを保存（ダッシュボード用）
        await this.scheduler.saveStatus(this.memory);
      },
    });

    // 提案チェック（5分ごと）
    this.scheduler.registerTask({
      id: 'suggestion_check',
      name: '提案チェック',
      intervalMs: 5 * 60 * 1000,
      enabled: true,
      requiresClaude: true,
      handler: async () => {
        await this.processPendingSuggestions();
      },
    });

    // ハートビート（30分ごと）
    this.scheduler.registerTask({
      id: 'heartbeat',
      name: 'ハートビート通知',
      intervalMs: 30 * 60 * 1000,
      enabled: true,
      requiresClaude: false,
      handler: async () => {
        const status = await this.heartbeat.beat();
        await this.discord.sendInfo(
          'ハートビート',
          `稼働時間: ${Math.floor(status.uptime / 60)}分, 状態: ${status.health.state}`
        );
      },
    });

    // 日次バックアップ（毎日3時）
    this.scheduler.registerTask({
      id: 'daily_backup',
      name: '日次バックアップ',
      cronExpression: '0 3 * * *',
      enabled: true,
      requiresClaude: false,
      handler: async () => {
        this.heartbeat.setPhase(WorkPhase.MAINTAINING, 'バックアップを作成中', 'daily_backup', {
          currentGoal: 'データ保護',
          nextSteps: ['バックアップ完了後に待機状態へ'],
        });
        await this.backupManager.dailyBackup();
        this.heartbeat.setPhase(WorkPhase.IDLE, '次のタスクを待機中', undefined, {
          nextSteps: ['次の定期タスクまで待機'],
        });
      },
    });

    // 日次分析（毎日6時）
    this.scheduler.registerTask({
      id: 'daily_analysis',
      name: '日次分析',
      cronExpression: '0 6 * * *',
      enabled: true,
      requiresClaude: true,
      handler: async () => {
        // 学習サイクルレビュー
        this.heartbeat.setPhase(WorkPhase.LEARNING, '過去のパフォーマンスをレビュー中', 'daily_analysis', {
          currentGoal: '日次分析・改善',
          nextSteps: ['戦略評価', '日報生成', 'Discordへ通知'],
        });
        await this.learningCycle.dailyReview();

        // 戦略評価
        this.heartbeat.setPhase(WorkPhase.REVIEWING, '収益化戦略の効果を評価中', 'daily_analysis', {
          currentGoal: '日次分析・改善',
          nextSteps: ['日報生成', 'Discordへ通知'],
        });
        await this.strategyManager.evaluateStrategies();

        // 日報生成
        this.heartbeat.setPhase(WorkPhase.ANALYZING, '日次レポートを生成中', 'daily_analysis', {
          currentGoal: '日次分析・改善',
          nextSteps: ['Discordへ通知'],
        });
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

        // タスク完了後は待機状態に戻す
        this.heartbeat.setPhase(WorkPhase.IDLE, '次のタスクを待機中', undefined, {
          nextSteps: ['次の定期タスクまで待機'],
        });
      },
    });

    // 週報生成（毎週月曜6時）
    this.scheduler.registerTask({
      id: 'weekly_report',
      name: '週報生成',
      cronExpression: '0 6 * * 1',
      enabled: true,
      requiresClaude: true,
      handler: async () => {
        this.heartbeat.setPhase(WorkPhase.ANALYZING, '週次レポートを生成中', 'weekly_report', {
          currentGoal: '週次振り返り',
          nextSteps: ['レポート生成', 'Discordへ通知'],
        });

        // 先週の週報を生成
        const lastWeek = new Date();
        lastWeek.setDate(lastWeek.getDate() - 7);
        const report = await this.reportGenerator.generateWeeklyReport();

        await this.discord.sendInfo(
          '週報',
          `${report.week}: タスク${report.totals.tasksCompleted}件完了, 純収益¥${report.totals.net.toLocaleString()}`
        );

        this.heartbeat.setPhase(WorkPhase.IDLE, '次のタスクを待機中', undefined, {
          nextSteps: ['次の定期タスクまで待機'],
        });
      },
    });

    // 戦略実行（30分ごと）
    this.scheduler.registerTask({
      id: 'strategy_execution',
      name: '戦略実行',
      intervalMs: 30 * 60 * 1000,
      enabled: true,
      requiresClaude: true,
      handler: async () => {
        this.heartbeat.setPhase(WorkPhase.IMPLEMENTING, '戦略を実行中', 'strategy_execution', {
          currentGoal: '収益化推進',
          nextSteps: ['アクティブ戦略の実行', '結果の記録'],
        });
        await this.strategyManager.executeActiveStrategies();
        this.heartbeat.setPhase(WorkPhase.IDLE, '次のタスクを待機中', undefined, {
          nextSteps: ['次の定期タスクまで待機'],
        });
      },
    });

    // 採択提案の自動実装（30分ごと）
    this.scheduler.registerTask({
      id: 'implement_accepted',
      name: '採択提案の自動実装',
      intervalMs: 30 * 60 * 1000,
      enabled: true,
      requiresClaude: true,
      handler: async () => {
        await this.implementAcceptedSuggestions();
      },
    });

    // 改善機会探索（1時間ごと）
    this.scheduler.registerTask({
      id: 'improvement_seek',
      name: '改善機会探索',
      intervalMs: 60 * 60 * 1000,
      enabled: true,
      requiresClaude: true,
      handler: async () => {
        this.heartbeat.setPhase(WorkPhase.LEARNING, '改善機会を探索中', 'improvement_seek', {
          currentGoal: '継続的改善',
          nextSteps: ['問題パターン分析', '改善検証確認'],
        });
        await this.learningCycle.seekImprovementOpportunities();
        this.heartbeat.setPhase(WorkPhase.IDLE, '次のタスクを待機中', undefined, {
          nextSteps: ['次の定期タスクまで待機'],
        });
      },
    });

    // 承認リクエストクリーンアップ（1時間ごと）
    this.scheduler.registerTask({
      id: 'approval_cleanup',
      name: '承認リクエストクリーンアップ',
      intervalMs: 60 * 60 * 1000,
      enabled: true,
      requiresClaude: false,
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
      requiresClaude: false,
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
      requiresClaude: false,
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

    // 戦略自動アクティベーション（1時間ごと）
    this.scheduler.registerTask({
      id: 'strategy_activation',
      name: '戦略自動アクティベーション',
      intervalMs: 60 * 60 * 1000,
      enabled: true,
      requiresClaude: true,
      handler: async () => {
        this.heartbeat.setPhase(WorkPhase.PLANNING, 'DRAFT戦略を評価中', 'strategy_activation', {
          currentGoal: '戦略自動有効化',
          nextSteps: ['戦略評価', '低リスク戦略の自動アクティベート'],
        });
        const result = await this.strategyActivator.evaluateAndActivateDrafts();
        logger.info('Strategy activation completed', result);
        this.heartbeat.setPhase(WorkPhase.IDLE, '次のタスクを待機中', undefined, {
          nextSteps: ['次の定期タスクまで待機'],
        });
      },
    });

    // 自動改善処理（1時間ごと）
    this.scheduler.registerTask({
      id: 'auto_improve',
      name: '自動改善処理',
      intervalMs: 60 * 60 * 1000,
      enabled: true,
      requiresClaude: true,
      handler: async () => {
        this.heartbeat.setPhase(WorkPhase.LEARNING, '保留中の改善を自動処理中', 'auto_improve', {
          currentGoal: '自動改善',
          nextSteps: ['リスク評価', '低リスク改善の自動実装'],
        });
        const result = await this.autoImprover.processImprovements();
        logger.info('Auto improvement completed', result);

        // ロールバックチェック
        const rolledBack = await this.autoImprover.checkForRollback();
        if (rolledBack.length > 0) {
          logger.warn('Improvements rolled back due to issues', { count: rolledBack.length });
        }

        this.heartbeat.setPhase(WorkPhase.IDLE, '次のタスクを待機中', undefined, {
          nextSteps: ['次の定期タスクまで待機'],
        });
      },
    });

    // 改善検証（毎日7時）
    this.scheduler.registerTask({
      id: 'improvement_verify',
      name: '改善検証',
      cronExpression: '0 7 * * *',
      enabled: true,
      requiresClaude: true,
      handler: async () => {
        this.heartbeat.setPhase(WorkPhase.REVIEWING, '実装済み改善の効果を検証中', 'improvement_verify', {
          currentGoal: '改善効果検証',
          nextSteps: ['7日以上経過した改善の検証', '結果レポート'],
        });
        const result = await this.autoImprover.verifyImplementedImprovements();
        logger.info('Improvement verification completed', result);

        if (result.verified > 0 || result.failed > 0) {
          await this.discord.sendInfo(
            '改善検証完了',
            `検証済み: ${result.verified}件, 失敗: ${result.failed}件, 待機中: ${result.pending}件`
          );
        }

        this.heartbeat.setPhase(WorkPhase.IDLE, '次のタスクを待機中', undefined, {
          nextSteps: ['次の定期タスクまで待機'],
        });
      },
    });

    // システム診断（毎日5時）
    this.scheduler.registerTask({
      id: 'system_diagnosis',
      name: 'システム診断',
      cronExpression: '0 5 * * *',
      enabled: true,
      requiresClaude: true,
      handler: async () => {
        this.heartbeat.setPhase(WorkPhase.ANALYZING, 'システム全体を診断中', 'system_diagnosis', {
          currentGoal: 'システム健康診断',
          nextSteps: ['コンポーネント診断', 'パフォーマンス分析', '改善提案'],
        });

        const diagnostician = getSystemDiagnostician();
        const report = await diagnostician.runFullDiagnosis();

        logger.info('System diagnosis completed', {
          overallStatus: report.overallStatus,
          issueCount: report.issues.length,
          recommendationCount: report.recommendations.length,
        });

        this.heartbeat.setPhase(WorkPhase.IDLE, '次のタスクを待機中', undefined, {
          nextSteps: ['次の定期タスクまで待機'],
        });
      },
    });

    // 週次振り返り（毎週日曜21時）
    this.scheduler.registerTask({
      id: 'weekly_retrospective',
      name: '週次振り返り',
      cronExpression: '0 21 * * 0',
      enabled: true,
      requiresClaude: true,
      handler: async () => {
        this.heartbeat.setPhase(WorkPhase.LEARNING, '週次振り返りを実行中', 'weekly_retrospective', {
          currentGoal: '週次振り返り',
          nextSteps: ['成功事例分析', '改善点特定', 'アクションアイテム生成'],
        });

        const retrospective = getRetrospectiveAnalyzer();
        const report = await retrospective.conductWeeklyRetrospective();

        logger.info('Weekly retrospective completed', {
          wellCount: report.whatWentWell.length,
          wrongCount: report.whatWentWrong.length,
          actionItemCount: report.actionItems.length,
        });

        this.heartbeat.setPhase(WorkPhase.IDLE, '次のタスクを待機中', undefined, {
          nextSteps: ['次の定期タスクまで待機'],
        });
      },
    });

    // 成功パターン抽出（毎週土曜9時）
    this.scheduler.registerTask({
      id: 'pattern_extraction',
      name: '成功パターン抽出',
      cronExpression: '0 9 * * 6',
      enabled: true,
      requiresClaude: true,
      handler: async () => {
        this.heartbeat.setPhase(WorkPhase.LEARNING, '成功パターンを抽出中', 'pattern_extraction', {
          currentGoal: 'パターン抽出・再利用化',
          nextSteps: ['パターン検出', '再利用形式への変換'],
        });

        const extractor = getPatternExtractor();
        const patterns = await extractor.extractPatterns();

        logger.info('Pattern extraction completed', {
          newPatternCount: patterns.length,
        });

        // 未変換パターンを自動変換
        const unconverted = extractor.getUnconvertedPatterns();
        for (const pattern of unconverted.slice(0, 3)) { // 最大3件
          try {
            await extractor.convertPattern(pattern.id);
          } catch (error) {
            logger.warn('Failed to convert pattern', { patternId: pattern.id, error });
          }
        }

        this.heartbeat.setPhase(WorkPhase.IDLE, '次のタスクを待機中', undefined, {
          nextSteps: ['次の定期タスクまで待機'],
        });
      },
    });

    // ドキュメント同期チェック（毎日8時）
    this.scheduler.registerTask({
      id: 'doc_sync_check',
      name: 'ドキュメント同期チェック',
      cronExpression: '0 8 * * *',
      enabled: true,
      requiresClaude: true,
      handler: async () => {
        this.heartbeat.setPhase(WorkPhase.REVIEWING, 'ドキュメント同期状態を確認中', 'doc_sync_check', {
          currentGoal: 'ドキュメント同期',
          nextSteps: ['ソースファイルとドキュメントの更新日時を比較', '必要に応じて更新提案を生成'],
        });

        const docSyncChecker = getDocSyncChecker();
        const suggestion = await docSyncChecker.generateUpdateSuggestion();

        if (suggestion) {
          // 提案システムに登録
          this.suggestionGate.create({
            title: suggestion.title,
            content: suggestion.content,
            category: suggestion.category,
            priority: suggestion.priority,
          });

          logger.info('Document sync suggestion created', {
            outdatedCount: suggestion.outdatedFiles.length,
          });
        } else {
          logger.info('All documents are in sync');
        }

        this.heartbeat.setPhase(WorkPhase.IDLE, '次のタスクを待機中', undefined, {
          nextSteps: ['次の定期タスクまで待機'],
        });
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

  private async runInitialTasks(): Promise<void> {
    logger.info('Running initial tasks after startup');

    try {
      // 提案チェック
      this.heartbeat.setPhase(WorkPhase.PLANNING, '起動後の提案を確認中', 'initial_check', {
        currentGoal: '初期化',
        nextSteps: ['提案確認', '戦略実行', '改善探索'],
      });
      await this.processPendingSuggestions();

      // 戦略実行
      this.heartbeat.setPhase(WorkPhase.IMPLEMENTING, '起動後の戦略を実行中', 'initial_check', {
        currentGoal: '初期化',
        nextSteps: ['戦略実行', '改善探索'],
      });
      await this.strategyManager.executeActiveStrategies();

      // 改善機会探索
      this.heartbeat.setPhase(WorkPhase.LEARNING, '起動後の改善機会を探索中', 'initial_check', {
        currentGoal: '初期化',
        nextSteps: ['改善探索'],
      });
      await this.learningCycle.seekImprovementOpportunities();

      // 完了後はIDLEに
      this.heartbeat.setPhase(WorkPhase.IDLE, '次のタスクを待機中', undefined, {
        nextSteps: ['次の定期タスクまで待機'],
      });

      logger.info('Initial tasks completed');
    } catch (error) {
      logger.error('Initial tasks failed', { error });
      this.heartbeat.setPhase(WorkPhase.IDLE, '初期タスクでエラー発生', undefined, {
        nextSteps: ['定期タスクで再試行'],
      });
    }
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
    // レートリミット中は提案処理をスキップ
    if (getRateLimitManager().isRateLimited()) {
      logger.info('Skipping suggestion processing due to rate limit', {
        remainingMs: getRateLimitManager().getRemainingCooldownMs(),
      });
      return;
    }

    const pendingSuggestions = this.suggestionGate.getPending();
    const deferredSuggestions = this.suggestionGate.getDeferred();

    const totalCount = pendingSuggestions.length + deferredSuggestions.length;

    if (totalCount === 0) {
      return;
    }

    logger.info('Processing suggestions', {
      pending: pendingSuggestions.length,
      deferred: deferredSuggestions.length,
    });

    // 新規提案を処理
    if (pendingSuggestions.length > 0) {
      this.heartbeat.setPhase(WorkPhase.PLANNING, `新規提案を検討中（${pendingSuggestions.length}件）`, 'suggestions', {
        currentGoal: 'ユーザー要望への対応',
        nextSteps: ['AI分析・評価', 'Discordへ回答を通知'],
      });

      for (const suggestion of pendingSuggestions) {
        // レートリミットが発生したら残りの処理をスキップ
        if (getRateLimitManager().isRateLimited()) {
          logger.info('Stopping suggestion processing due to rate limit detection');
          break;
        }

        this.heartbeat.setPhase(WorkPhase.PLANNING, `ユーザー提案「${suggestion.title}」をAI分析中`, 'suggestions', {
          currentGoal: 'ユーザー要望への対応',
          nextSteps: ['提案の分析・評価', 'Discordへ回答を通知'],
        });
        try {
          // AI分析を実行
          const analysis = await this.analyzeSuggestionWithAI(suggestion);

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

          // Discord通知
          await this.discord.sendSuggestionResponse(
            '提案への回答',
            `「${suggestion.title}」に回答しました: ${analysis.decision}`
          );

          // 監査ログ
          await this.auditLogger.log({
            actionType: 'suggestion_respond',
            description: `AI responded to suggestion: ${suggestion.title}`,
            actor: 'ai',
            riskLevel: 1,
            approved: true,
            success: true,
          });
        } catch (error) {
          logger.error('Failed to process suggestion', { id: suggestion.id, error });

          // レートリミット中はフォールバックを使わず、提案をpendingのまま維持
          if (getRateLimitManager().isRateLimited()) {
            logger.info('Keeping suggestion as pending due to rate limit', { id: suggestion.id });
            continue;
          }

          // フォールバック: 簡易分析
          const fallbackAnalysis = this.analyzeSuggestionFallback(suggestion);
          this.suggestionGate.respond(
            suggestion.id,
            {
              analysis: fallbackAnalysis.analysis,
              decision: fallbackAnalysis.decision,
              actionPlan: fallbackAnalysis.actionPlan,
            },
            fallbackAnalysis.status
          );
        }
      }
    }

    // 保留中の提案を再検討
    if (deferredSuggestions.length > 0 && !getRateLimitManager().isRateLimited()) {
      this.heartbeat.setPhase(WorkPhase.REVIEWING, `保留中の提案を再検討中（${deferredSuggestions.length}件）`, 'suggestions', {
        currentGoal: '保留提案の再評価',
        nextSteps: ['再検討', '状況変化の確認'],
      });

      for (const suggestion of deferredSuggestions) {
        // レートリミットが発生したら残りの処理をスキップ
        if (getRateLimitManager().isRateLimited()) {
          logger.info('Stopping deferred suggestion review due to rate limit');
          break;
        }
        await this.reviewDeferredSuggestion(suggestion);
      }
    }

    this.heartbeat.setPhase(WorkPhase.IDLE, '次のタスクを待機中', undefined, {
      nextSteps: ['次の定期タスクまで待機'],
    });
  }

  private async analyzeSuggestionWithAI(suggestion: Suggestion): Promise<{
    analysis: string;
    decision: string;
    actionPlan?: string;
    status: 'accepted' | 'rejected' | 'implemented' | 'deferred';
  }> {
    const claudeCLI = getClaudeCLI();

    const isQuestion = suggestion.category === 'question';

    const prompt = `あなたはAutoClaudeKMPシステムの提案分析AIです。以下のユーザー提案を分析し、適切に対応してください。

【提案情報】
- タイトル: ${suggestion.title}
- カテゴリ: ${suggestion.category}
- 優先度: ${suggestion.priority}
- 内容: ${suggestion.content}

【指示】
${isQuestion ? `これはユーザーからの質問です。質問に対して具体的かつ親切に回答してください。回答後はstatusを"implemented"（完了）としてください。` : `
この提案を分析し、以下の観点から評価してください:
1. 実現可能性
2. システムへの貢献度
3. 実装コスト

評価に基づいて以下のいずれかを決定してください:
- "accepted": 採択（実装予定に追加）
- "rejected": 却下（理由を明記）
- "deferred": 保留（追加情報や検討が必要）
`}

【回答形式】
以下のJSON形式で回答してください（他の文言は不要）:
{
  "analysis": "分析内容や質問への回答（詳しく記載）",
  "decision": "判断理由（1-2文）",
  "actionPlan": "採択の場合の実装計画（不要な場合はnull）",
  "status": "accepted|rejected|implemented|deferred"
}`;

    try {
      const result = await claudeCLI.executeTask({
        prompt,
        timeout: 60000,
        allowedTools: [], // ツール不要
      });

      if (!result.success) {
        throw new Error(`Claude CLI failed: ${result.error}`);
      }

      // JSONを抽出してパース
      const jsonMatch = result.output.match(/\{[\s\S]*\}/);
      if (!jsonMatch) {
        throw new Error('No JSON found in response');
      }

      const parsed = JSON.parse(jsonMatch[0]);

      // 質問の場合は必ずimplementedにする
      if (isQuestion && parsed.status !== 'implemented') {
        parsed.status = 'implemented';
      }

      return {
        analysis: parsed.analysis || '分析を完了しました。',
        decision: parsed.decision || '検討しました。',
        actionPlan: parsed.actionPlan || undefined,
        status: parsed.status || 'deferred',
      };
    } catch (error) {
      logger.error('AI analysis failed, using fallback', { error });
      throw error;
    }
  }

  private async reviewDeferredSuggestion(suggestion: Suggestion): Promise<void> {
    // レートリミット中はreviewCountをインクリメントしない
    if (getRateLimitManager().isRateLimited()) {
      logger.info('Skipping deferred review due to rate limit', { id: suggestion.id });
      return;
    }

    const reviewCount = this.suggestionGate.incrementReviewCount(suggestion.id);
    const maxReviews = 5; // 5回再検討後は自動却下

    logger.info('Reviewing deferred suggestion', {
      id: suggestion.id,
      title: suggestion.title,
      reviewCount,
    });

    // 再検討回数が上限に達した場合は自動却下
    if (reviewCount >= maxReviews) {
      this.suggestionGate.updateSuggestion(suggestion.id, {
        status: 'rejected',
        systemResponse: {
          analysis: `${maxReviews}回の再検討を行いましたが、現時点では採択できませんでした。`,
          decision: '再検討上限に達したため、自動的に却下されました。必要であれば再度提案してください。',
        },
      });

      await this.discord.sendInfo(
        '保留提案の自動却下',
        `「${suggestion.title}」は再検討上限（${maxReviews}回）に達したため却下されました。`
      );
      return;
    }

    // AIで再評価（簡易版）
    try {
      const claudeCLI = getClaudeCLI();

      const prompt = `以下の保留中の提案を再評価してください。状況に変化があれば採択または却下を判断してください。

【提案情報】
- タイトル: ${suggestion.title}
- カテゴリ: ${suggestion.category}
- 内容: ${suggestion.content}
- 再検討回数: ${reviewCount}回目

現時点で採択または却下を決定できる場合はそのステータスを、まだ判断できない場合は"deferred"を返してください。

回答形式（JSONのみ）:
{
  "status": "accepted|rejected|deferred",
  "reason": "判断理由"
}`;

      const result = await claudeCLI.executeTask({
        prompt,
        timeout: 30000,
        allowedTools: [],
      });

      // レートリミットが検出された場合は処理を中断（reviewCountは既にインクリメント済みだが許容）
      if (result.isRateLimited) {
        logger.info('Rate limit detected during deferred review', { id: suggestion.id });
        return;
      }

      if (result.success) {
        const jsonMatch = result.output.match(/\{[\s\S]*\}/);
        if (jsonMatch) {
          const parsed = JSON.parse(jsonMatch[0]);

          if (parsed.status && parsed.status !== 'deferred') {
            this.suggestionGate.updateSuggestion(suggestion.id, {
              status: parsed.status,
              systemResponse: {
                analysis: `再検討（${reviewCount}回目）の結果、判断を更新しました。`,
                decision: parsed.reason || '再評価により判断を変更しました。',
              },
            });

            await this.discord.sendInfo(
              '保留提案の再評価',
              `「${suggestion.title}」が再評価により「${parsed.status}」に更新されました。`
            );
          }
        }
      }
    } catch (error) {
      logger.debug('Deferred review AI failed, keeping deferred status', { error });
      // 失敗した場合は保留のまま
    }
  }

  private async implementAcceptedSuggestions(): Promise<void> {
    const acceptedSuggestions = this.suggestionGate.getAccepted();

    if (acceptedSuggestions.length === 0) {
      return;
    }

    logger.info('Implementing accepted suggestions', { count: acceptedSuggestions.length });

    const claudeCLI = getClaudeCLI();

    for (const suggestion of acceptedSuggestions) {
      this.heartbeat.setPhase(WorkPhase.IMPLEMENTING, `採択提案「${suggestion.title}」を実装中`, 'implement_accepted', {
        currentGoal: '提案の自動実装',
        nextSteps: ['ClaudeCLIで実装', '結果を記録'],
      });

      try {
        const prompt = `以下の採択された提案を実装してください。

【提案情報】
- タイトル: ${suggestion.title}
- カテゴリ: ${suggestion.category}
- 内容: ${suggestion.content}
${suggestion.systemResponse?.actionPlan ? `- アクションプラン: ${suggestion.systemResponse.actionPlan}` : ''}

【指示】
この提案に基づいて、必要なコード変更を実装してください。
- 既存のコードベースのスタイルに従ってください
- 必要最小限の変更に留めてください
- 実装完了後、何を変更したかを簡潔に説明してください`;

        const result = await claudeCLI.executeTask({
          prompt,
          allowedTools: ['Read', 'Write', 'Edit', 'Bash', 'Glob', 'Grep'],
          timeout: 5 * 60 * 1000, // 5分
        });

        if (result.success) {
          // 成功したらimplementedに更新
          this.suggestionGate.updateSuggestion(suggestion.id, {
            status: 'implemented',
            systemResponse: {
              analysis: suggestion.systemResponse?.analysis || '実装を完了しました。',
              decision: `実装完了: ${result.output.slice(0, 200)}${result.output.length > 200 ? '...' : ''}`,
            },
          });

          await this.discord.sendSuccess(
            '提案を自動実装',
            `「${suggestion.title}」の実装が完了しました。`
          );

          await this.auditLogger.log({
            actionType: 'suggestion_implement',
            description: `Implemented suggestion: ${suggestion.title}`,
            actor: 'ai',
            riskLevel: 2,
            approved: true,
            success: true,
          });

          logger.info('Suggestion implemented successfully', { id: suggestion.id, title: suggestion.title });
        } else {
          logger.error('Failed to implement suggestion', { id: suggestion.id, error: result.error });

          // 失敗した場合は保留に戻す
          this.suggestionGate.updateSuggestion(suggestion.id, {
            status: 'deferred',
            systemResponse: {
              analysis: suggestion.systemResponse?.analysis || '実装に失敗しました。',
              decision: `実装失敗: ${result.error}。再試行予定。`,
            },
          });

          await this.discord.sendWarning(
            '提案実装失敗',
            `「${suggestion.title}」の実装に失敗しました: ${result.error}`
          );
        }
      } catch (error) {
        const errorMessage = error instanceof Error ? error.message : String(error);
        logger.error('Error implementing suggestion', { id: suggestion.id, error: errorMessage });

        // エラーの場合も保留に戻す
        this.suggestionGate.updateSuggestion(suggestion.id, {
          status: 'deferred',
          systemResponse: {
            analysis: suggestion.systemResponse?.analysis || '実装中にエラーが発生しました。',
            decision: `エラー: ${errorMessage}。再試行予定。`,
          },
        });
      }
    }

    this.heartbeat.setPhase(WorkPhase.IDLE, '次のタスクを待機中', undefined, {
      nextSteps: ['次の定期タスクまで待機'],
    });
  }

  private analyzeSuggestionFallback(suggestion: Suggestion): {
    analysis: string;
    decision: string;
    actionPlan?: string;
    status: 'accepted' | 'rejected' | 'implemented' | 'deferred';
  } {
    const { category, priority, content } = suggestion;

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

    // 質問は回答済みとして処理
    if (category === 'question') {
      return {
        analysis: `ご質問を確認しました。詳細な回答はAI分析が復旧次第お送りします。`,
        decision: '質問を受け付けました',
        status: 'implemented',
      };
    }

    // その他は保留
    return {
      analysis: `提案を受け付けました。カテゴリ: ${category}, 優先度: ${priority}`,
      decision: '検討中です。しばらくお待ちください。',
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
