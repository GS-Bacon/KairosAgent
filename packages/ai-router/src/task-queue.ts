import { getLogger, generateId, sleep } from '@auto-claude/core';
import { TaskStatus } from '@auto-claude/core';
import type { Task } from '@auto-claude/core';
import { getClaudeCLI, type ClaudeTask, type ClaudeResult } from './claude-cli.js';

const logger = getLogger('ai-router:queue');

export interface QueuedTask extends Task {
  claudeTask: ClaudeTask;
  result?: ClaudeResult;
}

export interface QueueConfig {
  maxConcurrent: number;
  defaultPriority: number;
  retryDelayMs: number;
}

export type TaskHandler = (task: QueuedTask) => Promise<void>;

export class TaskQueue {
  private config: QueueConfig;
  private queue: QueuedTask[] = [];
  private running: Map<string, QueuedTask> = new Map();
  private completed: QueuedTask[] = [];
  private paused: boolean = false;
  private handlers: Map<string, TaskHandler> = new Map();
  private claudeCLI = getClaudeCLI();

  constructor(config: Partial<QueueConfig> = {}) {
    this.config = {
      maxConcurrent: config.maxConcurrent ?? 1,
      defaultPriority: config.defaultPriority ?? 5,
      retryDelayMs: config.retryDelayMs ?? 5000,
    };
    logger.info('TaskQueue initialized', this.config);
  }

  async enqueue(
    claudeTask: ClaudeTask,
    options: {
      type?: string;
      description?: string;
      priority?: number;
      maxRetries?: number;
    } = {}
  ): Promise<string> {
    const task: QueuedTask = {
      id: generateId('task'),
      type: options.type ?? 'default',
      description: options.description ?? claudeTask.prompt.slice(0, 100),
      priority: options.priority ?? this.config.defaultPriority,
      status: TaskStatus.PENDING,
      createdAt: new Date(),
      retryCount: 0,
      maxRetries: options.maxRetries ?? 3,
      claudeTask,
    };

    this.queue.push(task);
    this.sortQueue();

    logger.info('Task enqueued', { taskId: task.id, type: task.type, priority: task.priority });

    // 自動処理を開始
    this.processQueue();

    return task.id;
  }

  private sortQueue(): void {
    this.queue.sort((a, b) => b.priority - a.priority);
  }

  private async processQueue(): Promise<void> {
    if (this.paused) return;

    while (
      this.queue.length > 0 &&
      this.running.size < this.config.maxConcurrent
    ) {
      const task = this.queue.shift();
      if (!task) break;

      this.executeTask(task);
    }
  }

  private async executeTask(task: QueuedTask): Promise<void> {
    task.status = TaskStatus.RUNNING;
    task.startedAt = new Date();
    this.running.set(task.id, task);

    logger.info('Task started', { taskId: task.id, type: task.type });

    try {
      const result = await this.claudeCLI.executeTask(task.claudeTask);
      task.result = result;

      if (result.success) {
        task.status = TaskStatus.COMPLETED;
        task.completedAt = new Date();
        logger.info('Task completed', { taskId: task.id, duration: result.duration });
      } else {
        throw new Error(result.error ?? 'Task failed');
      }
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : String(error);

      if (task.retryCount < task.maxRetries) {
        task.retryCount++;
        task.status = TaskStatus.PENDING;
        this.queue.push(task);
        this.sortQueue();

        logger.warn('Task failed, retrying', {
          taskId: task.id,
          attempt: task.retryCount,
          error: errorMessage,
        });

        await sleep(this.config.retryDelayMs);
      } else {
        task.status = TaskStatus.FAILED;
        task.completedAt = new Date();
        task.error = errorMessage;

        logger.error('Task failed permanently', { taskId: task.id, error: errorMessage });
      }
    } finally {
      this.running.delete(task.id);
      this.completed.push(task);

      // 完了ハンドラを呼び出し
      const handler = this.handlers.get(task.type);
      if (handler) {
        try {
          await handler(task);
        } catch (handlerError) {
          logger.error('Task handler error', { taskId: task.id, error: handlerError });
        }
      }

      // 次のタスクを処理
      this.processQueue();
    }
  }

  registerHandler(taskType: string, handler: TaskHandler): void {
    this.handlers.set(taskType, handler);
    logger.debug('Handler registered', { taskType });
  }

  pause(): void {
    this.paused = true;
    logger.info('Queue paused');
  }

  resume(): void {
    this.paused = false;
    logger.info('Queue resumed');
    this.processQueue();
  }

  pauseHeavyTasks(): void {
    // 優先度が低いタスクを一時的に保留
    const heavyTasks = this.queue.filter((t) => t.priority < 5);
    this.queue = this.queue.filter((t) => t.priority >= 5);

    for (const task of heavyTasks) {
      task.priority -= 10; // 優先度を下げて後で再追加
    }

    this.queue.push(...heavyTasks);
    this.sortQueue();

    logger.info('Heavy tasks deprioritized', { count: heavyTasks.length });
  }

  getTask(taskId: string): QueuedTask | undefined {
    return (
      this.queue.find((t) => t.id === taskId) ??
      this.running.get(taskId) ??
      this.completed.find((t) => t.id === taskId)
    );
  }

  getCurrentTask(): QueuedTask | undefined {
    const running = Array.from(this.running.values());
    return running[0];
  }

  getPendingTasks(): QueuedTask[] {
    return [...this.queue];
  }

  getRunningTasks(): QueuedTask[] {
    return Array.from(this.running.values());
  }

  getCompletedTasks(limit: number = 100): QueuedTask[] {
    return this.completed.slice(-limit);
  }

  cancelTask(taskId: string): boolean {
    // キューから削除
    const index = this.queue.findIndex((t) => t.id === taskId);
    if (index !== -1) {
      const task = this.queue.splice(index, 1)[0];
      task.status = TaskStatus.CANCELLED;
      this.completed.push(task);
      logger.info('Task cancelled from queue', { taskId });
      return true;
    }

    // 実行中のタスクをキャンセル
    const running = this.running.get(taskId);
    if (running) {
      this.claudeCLI.cancelTask(taskId);
      running.status = TaskStatus.CANCELLED;
      this.running.delete(taskId);
      this.completed.push(running);
      logger.info('Running task cancelled', { taskId });
      return true;
    }

    return false;
  }

  clear(): void {
    this.queue = [];
    this.claudeCLI.cancelAllTasks();
    this.running.clear();
    logger.info('Queue cleared');
  }

  getStats(): {
    pending: number;
    running: number;
    completed: number;
    failed: number;
  } {
    const failed = this.completed.filter((t) => t.status === TaskStatus.FAILED).length;

    return {
      pending: this.queue.length,
      running: this.running.size,
      completed: this.completed.length,
      failed,
    };
  }
}

let instance: TaskQueue | null = null;

export function getTaskQueue(config?: Partial<QueueConfig>): TaskQueue {
  if (!instance) {
    instance = new TaskQueue(config);
  }
  return instance;
}
