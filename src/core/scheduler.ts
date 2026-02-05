import { logger } from "./logger.js";

export interface ScheduledTask {
  id: string;
  name: string;
  interval: number;
  handler: () => Promise<void>;
  lastRun?: Date;
  nextRun?: Date;
  isRunning: boolean;
}

export class Scheduler {
  private tasks: Map<string, ScheduledTask> = new Map();
  private timers: Map<string, NodeJS.Timeout> = new Map();
  private isRunning: boolean = false;

  register(
    id: string,
    name: string,
    interval: number,
    handler: () => Promise<void>
  ): void {
    if (this.tasks.has(id)) {
      logger.warn(`Task ${id} already registered, replacing`);
      this.unregister(id);
    }

    this.tasks.set(id, {
      id,
      name,
      interval,
      handler,
      isRunning: false,
    });

    logger.info(`Registered task: ${name}`, { id, interval });
  }

  unregister(id: string): void {
    const timer = this.timers.get(id);
    if (timer) {
      clearInterval(timer);
      this.timers.delete(id);
    }
    this.tasks.delete(id);
    logger.info(`Unregistered task: ${id}`);
  }

  private async runTask(task: ScheduledTask): Promise<void> {
    if (task.isRunning) {
      logger.warn(`Task ${task.name} is already running, skipping`);
      return;
    }

    task.isRunning = true;
    task.lastRun = new Date();

    try {
      logger.debug(`Running task: ${task.name}`);
      await task.handler();
      logger.debug(`Task completed: ${task.name}`);
    } catch (err) {
      const errorMessage = err instanceof Error ? err.message : String(err);
      logger.error(`Task failed: ${task.name}`, { error: errorMessage });
    } finally {
      task.isRunning = false;
      task.nextRun = new Date(Date.now() + task.interval);
    }
  }

  start(): void {
    if (this.isRunning) {
      logger.warn("Scheduler already running");
      return;
    }

    this.isRunning = true;
    logger.info("Starting scheduler");

    for (const task of this.tasks.values()) {
      this.runTask(task);

      const timer = setInterval(() => {
        this.runTask(task);
      }, task.interval);

      this.timers.set(task.id, timer);
    }
  }

  stop(): void {
    if (!this.isRunning) return;

    logger.info("Stopping scheduler");

    for (const timer of this.timers.values()) {
      clearInterval(timer);
    }
    this.timers.clear();
    this.isRunning = false;
  }

  async runNow(id: string): Promise<void> {
    const task = this.tasks.get(id);
    if (!task) {
      throw new Error(`Task not found: ${id}`);
    }
    await this.runTask(task);
  }

  getStatus(): { tasks: ScheduledTask[]; isRunning: boolean } {
    return {
      tasks: Array.from(this.tasks.values()),
      isRunning: this.isRunning,
    };
  }
}

export const scheduler = new Scheduler();
