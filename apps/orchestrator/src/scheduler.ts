import { getLogger, getRateLimitManager } from '@auto-claude/core';
import { MemoryManager } from '@auto-claude/memory';

const logger = getLogger('orchestrator:scheduler');

export interface ScheduledTask {
  id: string;
  name: string;
  cronExpression?: string;
  intervalMs?: number;
  handler: () => Promise<void>;
  lastRun?: Date;
  nextRun?: Date;
  enabled: boolean;
  requiresClaude?: boolean;
}

export class Scheduler {
  private tasks: Map<string, ScheduledTask> = new Map();
  private timers: Map<string, NodeJS.Timeout> = new Map();
  private running: boolean = false;

  constructor() {
    logger.info('Scheduler initialized');
  }

  registerTask(task: Omit<ScheduledTask, 'lastRun' | 'nextRun'>): void {
    const fullTask: ScheduledTask = {
      ...task,
      nextRun: this.calculateNextRun(task),
    };

    this.tasks.set(task.id, fullTask);
    logger.info('Task registered', { id: task.id, name: task.name });

    if (this.running && task.enabled) {
      this.scheduleTask(fullTask);
    }
  }

  private calculateNextRun(
    task: Omit<ScheduledTask, 'lastRun' | 'nextRun'>
  ): Date {
    if (task.intervalMs) {
      return new Date(Date.now() + task.intervalMs);
    }

    // 簡易的なcron解析（毎時、毎日のみサポート）
    if (task.cronExpression) {
      const parts = task.cronExpression.split(' ');
      const now = new Date();

      if (parts[0] === '0' && parts[1] !== '*') {
        // 毎日特定時刻
        const hour = parseInt(parts[1], 10);
        const next = new Date(now);
        next.setHours(hour, 0, 0, 0);
        if (next <= now) {
          next.setDate(next.getDate() + 1);
        }
        return next;
      }

      if (parts[0] === '0' && parts[1] === '*') {
        // 毎時
        const next = new Date(now);
        next.setMinutes(0, 0, 0);
        next.setHours(next.getHours() + 1);
        return next;
      }
    }

    // デフォルト: 1時間後
    return new Date(Date.now() + 60 * 60 * 1000);
  }

  private scheduleTask(task: ScheduledTask): void {
    if (!task.enabled) return;

    const existingTimer = this.timers.get(task.id);
    if (existingTimer) {
      clearTimeout(existingTimer);
    }

    const delay = task.nextRun
      ? Math.max(0, task.nextRun.getTime() - Date.now())
      : 0;

    const timer = setTimeout(async () => {
      await this.executeTask(task);
    }, delay);

    this.timers.set(task.id, timer);
  }

  private async executeTask(task: ScheduledTask): Promise<void> {
    // レートリミット中はClaude依存タスクをスキップ
    if (task.requiresClaude && getRateLimitManager().isRateLimited()) {
      logger.info('Skipping Claude-dependent task due to rate limit', {
        id: task.id,
        name: task.name,
        remainingMs: getRateLimitManager().getRemainingCooldownMs(),
      });
      // 次回実行をスケジュールしてスキップ
      task.nextRun = this.calculateNextRun(task);
      this.scheduleTask(task);
      return;
    }

    logger.info('Executing scheduled task', { id: task.id, name: task.name });

    try {
      await task.handler();
      task.lastRun = new Date();
      logger.info('Task completed', { id: task.id });
    } catch (error) {
      logger.error('Task failed', { id: task.id, error });
    }

    // 次回実行をスケジュール
    task.nextRun = this.calculateNextRun(task);
    this.scheduleTask(task);
  }

  start(): void {
    if (this.running) return;

    this.running = true;
    logger.info('Scheduler started');

    for (const task of this.tasks.values()) {
      if (task.enabled) {
        this.scheduleTask(task);
      }
    }
  }

  stop(): void {
    this.running = false;

    for (const timer of this.timers.values()) {
      clearTimeout(timer);
    }
    this.timers.clear();

    logger.info('Scheduler stopped');
  }

  enableTask(taskId: string): void {
    const task = this.tasks.get(taskId);
    if (task) {
      task.enabled = true;
      if (this.running) {
        this.scheduleTask(task);
      }
    }
  }

  disableTask(taskId: string): void {
    const task = this.tasks.get(taskId);
    if (task) {
      task.enabled = false;
      const timer = this.timers.get(taskId);
      if (timer) {
        clearTimeout(timer);
        this.timers.delete(taskId);
      }
    }
  }

  getTask(taskId: string): ScheduledTask | undefined {
    return this.tasks.get(taskId);
  }

  getAllTasks(): ScheduledTask[] {
    return Array.from(this.tasks.values());
  }

  getNextScheduledTask(): ScheduledTask | null {
    let next: ScheduledTask | null = null;
    let nextTime = Infinity;

    for (const task of this.tasks.values()) {
      if (task.enabled && task.nextRun && task.nextRun.getTime() < nextTime) {
        next = task;
        nextTime = task.nextRun.getTime();
      }
    }

    return next;
  }

  async saveStatus(memoryManager: MemoryManager): Promise<void> {
    const tasks = this.getAllTasks();
    await memoryManager.writeJson('scheduler-status.json', {
      timestamp: new Date().toISOString(),
      tasks: tasks.map((t) => ({
        id: t.id,
        name: t.name,
        enabled: t.enabled,
        lastRun: t.lastRun?.toISOString() ?? null,
        nextRun: t.nextRun?.toISOString() ?? null,
        intervalMs: t.intervalMs ?? null,
        cronExpression: t.cronExpression ?? null,
      })),
    });
    logger.debug('Scheduler status saved');
  }
}
