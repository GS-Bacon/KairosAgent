import express, { Express, Request, Response } from 'express';
import { WebSocketServer, WebSocket } from 'ws';
import { createServer } from 'http';
import { join, dirname } from 'path';
import { existsSync, readFileSync, writeFileSync, mkdirSync } from 'fs';
import { fileURLToPath } from 'url';
import { getLogger } from '@auto-claude/core';
import { getApprovalGate, getSuggestionGate, NOTIFICATION_ITEMS, NOTIFICATION_CATEGORIES, NotificationItemId } from '@auto-claude/notification';
import { getLedger } from '@auto-claude/ledger';
import { getStrategyManager, getStrategyExecutor } from '@auto-claude/strategies';
import { getLossLimiter, getSystemRiskMonitor } from '@auto-claude/safety';
import { getTaskQueue } from '@auto-claude/ai-router';
import { getAuditLogger } from '@auto-claude/audit';
import { getReportGenerator } from '@auto-claude/self-improve';
import { getMemoryManager } from '@auto-claude/memory';
import {
  getErrorAggregator,
  getRepairQueue,
  getRepairCircuitBreaker,
  getAutoRepairer,
  type ErrorFilter,
} from '@auto-claude/error-aggregator';

const logger = getLogger('dashboard');

// プロジェクトルートを検出（.gitディレクトリを探す）
function findProjectRoot(startDir: string): string {
  let dir = startDir;
  while (dir !== '/') {
    if (existsSync(join(dir, '.git'))) {
      return dir;
    }
    dir = dirname(dir);
  }
  return startDir;
}

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const PROJECT_ROOT = findProjectRoot(__dirname);

// orchestratorのワークスペースを参照（notification-history等の共有データ用）
const ORCHESTRATOR_WORKSPACE = join(PROJECT_ROOT, 'apps/orchestrator/workspace');

export interface DashboardConfig {
  port: number;
  host: string;
}

export class DashboardServer {
  private app: Express;
  private wss: WebSocketServer | null = null;
  private config: DashboardConfig;
  private clients: Set<WebSocket> = new Set();

  constructor(config: Partial<DashboardConfig> = {}) {
    this.config = {
      port: config.port ?? 3000,
      host: config.host ?? '0.0.0.0',
    };

    this.app = express();
    this.setupMiddleware();
    this.setupRoutes();

    logger.info('DashboardServer created', this.config);
  }

  private setupMiddleware(): void {
    this.app.use(express.json());
    this.app.use(express.static(join(import.meta.dirname, '../public')));
  }

  private setupRoutes(): void {
    // ステータス API
    this.app.get('/api/status', async (req: Request, res: Response) => {
      try {
        const systemRisk = getSystemRiskMonitor();
        const systemStatus = await systemRisk.checkSystem();
        const memory = getMemoryManager();

        // SYSTEM_STATUS.jsonからcurrentPhaseを取得
        let currentPhase = null;
        try {
          const statusData = await memory.readJson('SYSTEM_STATUS.json') as {
            health?: { currentPhase?: unknown };
          } | null;
          if (statusData?.health?.currentPhase) {
            currentPhase = statusData.health.currentPhase;
          }
        } catch {
          // ファイルがない場合は無視
        }

        res.json({
          state: systemStatus.state,
          resources: systemStatus.resources,
          issues: systemStatus.issues,
          currentPhase,
        });
      } catch (error) {
        res.status(500).json({ error: 'Failed to get status' });
      }
    });

    // 収益 API
    this.app.get('/api/finance', async (req: Request, res: Response) => {
      try {
        const ledger = getLedger();
        const lossLimiter = getLossLimiter();

        const summary = await ledger.getSummary();
        const lossStatus = lossLimiter.getStatus();

        res.json({
          monthlyIncome: summary.totalIncome,
          monthlyExpense: summary.totalExpense,
          netProfit: summary.netProfit,
          remainingBudget: lossStatus.remaining,
          maxLoss: lossStatus.maxLoss,
        });
      } catch (error) {
        res.status(500).json({ error: 'Failed to get finance data' });
      }
    });

    // 戦略一覧 API
    this.app.get('/api/strategies', async (req: Request, res: Response) => {
      try {
        const strategyManager = getStrategyManager();
        const strategies = strategyManager.getAllStrategies();

        res.json(
          strategies.map((s) => ({
            id: s.id,
            name: s.name,
            status: s.status,
            performance: s.performance,
          }))
        );
      } catch (error) {
        res.status(500).json({ error: 'Failed to get strategies' });
      }
    });

    // 戦略詳細 API
    this.app.get('/api/strategies/:id', async (req: Request, res: Response) => {
      try {
        const strategyManager = getStrategyManager();
        const strategyExecutor = getStrategyExecutor();
        const strategy = strategyManager.getStrategy(req.params.id);

        if (!strategy) {
          res.status(404).json({ error: 'Strategy not found' });
          return;
        }

        // 中間結果を抽出（config内の _ で始まるキー）
        const intermediateResults: Record<string, unknown> = {};
        for (const [key, value] of Object.entries(strategy.config)) {
          if (key.startsWith('_')) {
            intermediateResults[key.slice(1)] = value;
          }
        }

        // 実行履歴を取得
        const executionHistory = strategyExecutor.getExecutionHistory(strategy.id);

        // 成功率を計算
        const successRate = strategy.performance.executionCount > 0
          ? (strategy.performance.successCount / strategy.performance.executionCount) * 100
          : 0;

        res.json({
          ...strategy,
          intermediateResults,
          executionHistory,
          successRate: Math.round(successRate * 10) / 10,
        });
      } catch (error) {
        res.status(500).json({ error: 'Failed to get strategy details' });
      }
    });

    // 承認リクエスト API
    this.app.get('/api/requests', async (req: Request, res: Response) => {
      try {
        const approvalGate = getApprovalGate();
        const requests = approvalGate.getPendingRequests();

        res.json(requests);
      } catch (error) {
        res.status(500).json({ error: 'Failed to get requests' });
      }
    });

    // 承認 API
    this.app.post('/api/requests/:id/approve', async (req: Request, res: Response) => {
      try {
        const approvalGate = getApprovalGate();
        const success = approvalGate.approve(req.params.id, 'dashboard');

        res.json({ success });
      } catch (error) {
        res.status(500).json({ error: 'Failed to approve request' });
      }
    });

    // 拒否 API
    this.app.post('/api/requests/:id/reject', async (req: Request, res: Response) => {
      try {
        const approvalGate = getApprovalGate();
        const success = approvalGate.reject(req.params.id, 'dashboard', req.body.reason);

        res.json({ success });
      } catch (error) {
        res.status(500).json({ error: 'Failed to reject request' });
      }
    });

    // ヘルスチェック
    this.app.get('/health', (req: Request, res: Response) => {
      res.json({ status: 'ok', timestamp: new Date().toISOString() });
    });

    // 現在のタスク API
    this.app.get('/api/task', (req: Request, res: Response) => {
      try {
        const taskQueue = getTaskQueue();
        const task = taskQueue.getCurrentTask();
        res.json(task ?? { status: 'idle', message: '実行中のタスクはありません' });
      } catch (error) {
        res.status(500).json({ error: 'Failed to get current task' });
      }
    });

    // アクティビティ API
    this.app.get('/api/activity', async (req: Request, res: Response) => {
      try {
        const auditLogger = getAuditLogger();
        const logs = await auditLogger.getRecent(5);
        res.json(logs);
      } catch (error) {
        res.status(500).json({ error: 'Failed to get activity' });
      }
    });

    // 提案一覧 API
    this.app.get('/api/suggestions', (req: Request, res: Response) => {
      try {
        const suggestionGate = getSuggestionGate();
        const suggestions = suggestionGate.getAll();
        res.json(suggestions);
      } catch (error) {
        res.status(500).json({ error: 'Failed to get suggestions' });
      }
    });

    // 提案作成 API
    this.app.post('/api/suggestions', (req: Request, res: Response) => {
      try {
        const suggestionGate = getSuggestionGate();
        const { title, content, category, priority } = req.body;

        if (!title || !content) {
          res.status(400).json({ error: 'Title and content are required' });
          return;
        }

        const suggestion = suggestionGate.create({
          title,
          content,
          category: category ?? 'other',
          priority: priority ?? 'medium',
        });

        res.json(suggestion);
      } catch (error) {
        res.status(500).json({ error: 'Failed to create suggestion' });
      }
    });

    // 提案詳細 API
    this.app.get('/api/suggestions/:id', (req: Request, res: Response) => {
      try {
        const suggestionGate = getSuggestionGate();
        const suggestion = suggestionGate.getById(req.params.id);

        if (!suggestion) {
          res.status(404).json({ error: 'Suggestion not found' });
          return;
        }

        res.json(suggestion);
      } catch (error) {
        res.status(500).json({ error: 'Failed to get suggestion' });
      }
    });

    // 日報一覧 API
    this.app.get('/api/reports/daily', async (req: Request, res: Response) => {
      try {
        const reportGenerator = getReportGenerator();
        const limit = parseInt(req.query.limit as string) || 7;
        const reports = await reportGenerator.listDailyReports(limit);
        res.json(reports);
      } catch (error) {
        res.status(500).json({ error: 'Failed to get daily reports' });
      }
    });

    // 日報詳細 API
    this.app.get('/api/reports/daily/:date', async (req: Request, res: Response) => {
      try {
        const reportGenerator = getReportGenerator();
        const report = await reportGenerator.getDailyReport(req.params.date);

        if (!report) {
          res.status(404).json({ error: 'Daily report not found' });
          return;
        }

        res.json(report);
      } catch (error) {
        res.status(500).json({ error: 'Failed to get daily report' });
      }
    });

    // 週報一覧 API
    this.app.get('/api/reports/weekly', async (req: Request, res: Response) => {
      try {
        const reportGenerator = getReportGenerator();
        const limit = parseInt(req.query.limit as string) || 4;
        const reports = await reportGenerator.listWeeklyReports(limit);
        res.json(reports);
      } catch (error) {
        res.status(500).json({ error: 'Failed to get weekly reports' });
      }
    });

    // 週報詳細 API
    this.app.get('/api/reports/weekly/:week', async (req: Request, res: Response) => {
      try {
        const reportGenerator = getReportGenerator();
        const report = await reportGenerator.getWeeklyReport(req.params.week);

        if (!report) {
          res.status(404).json({ error: 'Weekly report not found' });
          return;
        }

        res.json(report);
      } catch (error) {
        res.status(500).json({ error: 'Failed to get weekly report' });
      }
    });

    // スケジューラタスク一覧 API
    this.app.get('/api/scheduler', async (req: Request, res: Response) => {
      try {
        const memory = getMemoryManager();
        const status = await memory.readJson('scheduler-status.json');
        res.json(status ?? { tasks: [], timestamp: null });
      } catch (error) {
        res.status(500).json({ error: 'Failed to get scheduler status' });
      }
    });

    // 通知設定取得 API
    this.app.get('/api/notifications/settings', (req: Request, res: Response) => {
      try {
        const settingsPath = join(ORCHESTRATOR_WORKSPACE, 'notification-settings.json');
        const defaultItems = Object.fromEntries(
          NOTIFICATION_ITEMS.map(item => [item.id, item.defaultEnabled])
        );

        if (existsSync(settingsPath)) {
          const content = readFileSync(settingsPath, 'utf-8');
          const settings = JSON.parse(content);
          // デフォルト値とマージ
          res.json({
            discord: {
              info: true,
              success: true,
              warning: true,
              error: true,
              critical: true,
              audit: false,
              suggestionResponse: true,
              ...settings.discord,
            },
            items: { ...defaultItems, ...(settings.items || {}) },
          });
        } else {
          // デフォルト設定を返す
          res.json({
            discord: {
              info: true,
              success: true,
              warning: true,
              error: true,
              critical: true,
              audit: false,
              suggestionResponse: true,
            },
            items: defaultItems,
          });
        }
      } catch (error) {
        res.status(500).json({ error: 'Failed to get notification settings' });
      }
    });

    // 通知項目メタデータ取得 API
    this.app.get('/api/notifications/items', (req: Request, res: Response) => {
      res.json({
        items: NOTIFICATION_ITEMS,
        categories: NOTIFICATION_CATEGORIES,
      });
    });

    // 通知設定更新 API
    this.app.post('/api/notifications/settings', (req: Request, res: Response) => {
      try {
        const settingsPath = join(ORCHESTRATOR_WORKSPACE, 'notification-settings.json');

        if (!existsSync(ORCHESTRATOR_WORKSPACE)) {
          mkdirSync(ORCHESTRATOR_WORKSPACE, { recursive: true });
        }

        writeFileSync(settingsPath, JSON.stringify(req.body, null, 2));
        res.json({ success: true });
      } catch (error) {
        res.status(500).json({ error: 'Failed to save notification settings' });
      }
    });

    // 通知履歴取得 API
    this.app.get('/api/notifications/history', (req: Request, res: Response) => {
      try {
        const historyPath = join(ORCHESTRATOR_WORKSPACE, 'notification-history.json');
        if (existsSync(historyPath)) {
          const content = readFileSync(historyPath, 'utf-8');
          res.json(JSON.parse(content));
        } else {
          res.json([]);
        }
      } catch (error) {
        res.status(500).json({ error: 'Failed to get notification history' });
      }
    });

    // ========== エラー集約・自動修正 API ==========

    // エラー一覧 API
    this.app.get('/api/errors', (req: Request, res: Response) => {
      try {
        const aggregator = getErrorAggregator();

        const filter: ErrorFilter = {};
        if (req.query.sources) {
          filter.sources = (req.query.sources as string).split(',') as ErrorFilter['sources'];
        }
        if (req.query.statuses) {
          filter.statuses = (req.query.statuses as string).split(',') as ErrorFilter['statuses'];
        }
        if (req.query.severities) {
          filter.severities = (req.query.severities as string).split(',') as ErrorFilter['severities'];
        }
        if (req.query.limit) {
          filter.limit = parseInt(req.query.limit as string);
        }
        if (req.query.offset) {
          filter.offset = parseInt(req.query.offset as string);
        }

        const errors = aggregator.getErrors(filter);
        const stats = aggregator.getStats();

        res.json({ errors, stats });
      } catch (error) {
        res.status(500).json({ error: 'Failed to get errors' });
      }
    });

    // エラー詳細 API
    this.app.get('/api/errors/:id', (req: Request, res: Response) => {
      try {
        const aggregator = getErrorAggregator();
        const error = aggregator.getError(req.params.id);

        if (!error) {
          res.status(404).json({ error: 'Error not found' });
          return;
        }

        res.json(error);
      } catch (error) {
        res.status(500).json({ error: 'Failed to get error details' });
      }
    });

    // 手動修正トリガー API
    this.app.post('/api/errors/:id/repair', async (req: Request, res: Response) => {
      try {
        const repairer = getAutoRepairer();
        const customPrompt = req.body.prompt as string | undefined;

        const result = await repairer.repairError(req.params.id, customPrompt);

        if (!result) {
          res.status(400).json({ error: 'Failed to trigger repair' });
          return;
        }

        res.json({ success: result.success, result });
      } catch (error) {
        res.status(500).json({ error: 'Failed to trigger repair' });
      }
    });

    // エラーステータス更新 API
    this.app.patch('/api/errors/:id', (req: Request, res: Response) => {
      try {
        const aggregator = getErrorAggregator();
        const { status } = req.body;

        if (!status) {
          res.status(400).json({ error: 'Status is required' });
          return;
        }

        const success = aggregator.updateErrorStatus(req.params.id, status, 'manual');

        if (!success) {
          res.status(404).json({ error: 'Error not found' });
          return;
        }

        res.json({ success: true });
      } catch (error) {
        res.status(500).json({ error: 'Failed to update error status' });
      }
    });

    // 修正キュー API
    this.app.get('/api/repair-queue', (req: Request, res: Response) => {
      try {
        const queue = getRepairQueue();
        const tasks = queue.getTasks();
        const processing = queue.getProcessingTask();
        const pendingCount = queue.getPendingCount();

        res.json({ tasks, processing, pendingCount });
      } catch (error) {
        res.status(500).json({ error: 'Failed to get repair queue' });
      }
    });

    // 修正タスクキャンセル API
    this.app.post('/api/repair-queue/:taskId/cancel', (req: Request, res: Response) => {
      try {
        const queue = getRepairQueue();
        const success = queue.cancel(req.params.taskId);

        if (!success) {
          res.status(404).json({ error: 'Task not found' });
          return;
        }

        res.json({ success: true });
      } catch (error) {
        res.status(500).json({ error: 'Failed to cancel repair task' });
      }
    });

    // サーキットブレーカー状態 API
    this.app.get('/api/circuit-breaker', (req: Request, res: Response) => {
      try {
        const circuitBreaker = getRepairCircuitBreaker();
        const state = circuitBreaker.getState();
        const config = circuitBreaker.getConfig();
        const remainingCooldownMs = circuitBreaker.getRemainingCooldownMs();

        res.json({ state, config, remainingCooldownMs });
      } catch (error) {
        res.status(500).json({ error: 'Failed to get circuit breaker state' });
      }
    });

    // サーキットブレーカーリセット API
    this.app.post('/api/circuit-breaker/reset', (req: Request, res: Response) => {
      try {
        const circuitBreaker = getRepairCircuitBreaker();
        circuitBreaker.reset();

        res.json({ success: true });
      } catch (error) {
        res.status(500).json({ error: 'Failed to reset circuit breaker' });
      }
    });

    // 自動修正設定 API
    this.app.get('/api/auto-repairer', (req: Request, res: Response) => {
      try {
        const repairer = getAutoRepairer();
        const config = repairer.getConfig();
        const isRunning = repairer.isRunning();
        const isEnabled = repairer.isEnabled();

        res.json({ config, isRunning, isEnabled });
      } catch (error) {
        res.status(500).json({ error: 'Failed to get auto repairer status' });
      }
    });

    // 自動修正有効/無効切り替え API
    this.app.post('/api/auto-repairer/toggle', (req: Request, res: Response) => {
      try {
        const repairer = getAutoRepairer();
        const { enabled } = req.body;

        if (typeof enabled !== 'boolean') {
          res.status(400).json({ error: 'enabled (boolean) is required' });
          return;
        }

        repairer.setEnabled(enabled);
        res.json({ success: true, enabled: repairer.isEnabled() });
      } catch (error) {
        res.status(500).json({ error: 'Failed to toggle auto repairer' });
      }
    });
  }

  start(): void {
    const server = createServer(this.app);

    // WebSocket設定
    this.wss = new WebSocketServer({ server });

    this.wss.on('connection', (ws: WebSocket) => {
      this.clients.add(ws);
      logger.debug('WebSocket client connected');

      ws.on('close', () => {
        this.clients.delete(ws);
        logger.debug('WebSocket client disconnected');
      });

      ws.on('error', (error) => {
        logger.error('WebSocket error', { error });
      });
    });

    server.listen(this.config.port, this.config.host, () => {
      logger.info('Dashboard server started', {
        url: `http://${this.config.host}:${this.config.port}`,
      });
    });
  }

  broadcast(event: { type: string; data: unknown }): void {
    const message = JSON.stringify(event);

    for (const client of this.clients) {
      if (client.readyState === WebSocket.OPEN) {
        client.send(message);
      }
    }
  }

  notifyTaskUpdate(task: { id: string; status: string; description: string }): void {
    this.broadcast({ type: 'task', data: task });
  }

  notifyFinanceUpdate(update: { type: string; amount: number }): void {
    this.broadcast({ type: 'finance', data: update });
  }
}
