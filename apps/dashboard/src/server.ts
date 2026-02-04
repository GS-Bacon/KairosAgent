import express, { Express, Request, Response } from 'express';
import { WebSocketServer, WebSocket } from 'ws';
import { createServer } from 'http';
import { join } from 'path';
import { existsSync, readFileSync, writeFileSync, mkdirSync } from 'fs';
import { getLogger } from '@auto-claude/core';
import { getApprovalGate, getSuggestionGate } from '@auto-claude/notification';
import { getLedger } from '@auto-claude/ledger';
import { getStrategyManager } from '@auto-claude/strategies';
import { getLossLimiter, getSystemRiskMonitor } from '@auto-claude/safety';
import { getTaskQueue } from '@auto-claude/ai-router';
import { getAuditLogger } from '@auto-claude/audit';
import { getReportGenerator } from '@auto-claude/self-improve';
import { getMemoryManager } from '@auto-claude/memory';

const logger = getLogger('dashboard');

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

    // 戦略 API
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
        const settingsPath = join(process.cwd(), 'workspace', 'notification-settings.json');
        if (existsSync(settingsPath)) {
          const content = readFileSync(settingsPath, 'utf-8');
          res.json(JSON.parse(content));
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
          });
        }
      } catch (error) {
        res.status(500).json({ error: 'Failed to get notification settings' });
      }
    });

    // 通知設定更新 API
    this.app.post('/api/notifications/settings', (req: Request, res: Response) => {
      try {
        const workspaceDir = join(process.cwd(), 'workspace');
        const settingsPath = join(workspaceDir, 'notification-settings.json');

        if (!existsSync(workspaceDir)) {
          mkdirSync(workspaceDir, { recursive: true });
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
        const historyPath = join(process.cwd(), 'workspace', 'notification-history.json');
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
