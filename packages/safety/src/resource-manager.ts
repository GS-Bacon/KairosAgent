import { getLogger, sleep } from '@auto-claude/core';
import type { ResourceUsage } from '@auto-claude/core';
import { freemem, totalmem, cpus, loadavg } from 'os';
import { execSync } from 'child_process';

const logger = getLogger('safety:resource-manager');

export interface ResourceLimits {
  maxCpuPercent: number;
  maxMemoryMB: number;
  maxDiskGB: number;
  maxProcesses: number;
  maxNetworkMbps: number;
  idleThrottlePercent: number;
}

export interface ResourceStatus {
  usage: ResourceUsage;
  withinLimits: boolean;
  throttled: boolean;
  lowPriorityMode: boolean;
}

export class ResourceManager {
  private limits: ResourceLimits;
  private lowPriorityMode: boolean = false;
  private throttled: boolean = false;

  constructor(limits: Partial<ResourceLimits> = {}) {
    this.limits = {
      maxCpuPercent: limits.maxCpuPercent ?? 30,
      maxMemoryMB: limits.maxMemoryMB ?? 2048,
      maxDiskGB: limits.maxDiskGB ?? 10,
      maxProcesses: limits.maxProcesses ?? 20,
      maxNetworkMbps: limits.maxNetworkMbps ?? 10,
      idleThrottlePercent: limits.idleThrottlePercent ?? 10,
    };
    logger.info('ResourceManager initialized', this.limits);
  }

  async checkResources(): Promise<ResourceStatus> {
    const usage = await this.getCurrentUsage();
    let withinLimits = true;

    // CPU チェック
    if (usage.cpuPercent > this.limits.maxCpuPercent) {
      logger.warn('CPU limit exceeded', {
        current: usage.cpuPercent,
        limit: this.limits.maxCpuPercent,
      });
      await this.throttle('cpu');
      withinLimits = false;
    }

    // メモリチェック
    if (usage.memoryMB > this.limits.maxMemoryMB) {
      logger.warn('Memory limit exceeded', {
        current: usage.memoryMB,
        limit: this.limits.maxMemoryMB,
      });
      await this.reduceMemory();
      withinLimits = false;
    }

    // システム全体の負荷チェック
    const systemLoad = await this.getSystemLoad();
    if (systemLoad.high) {
      await this.enterLowPriorityMode();
    } else if (this.lowPriorityMode && !systemLoad.moderate) {
      await this.exitLowPriorityMode();
    }

    return {
      usage,
      withinLimits,
      throttled: this.throttled,
      lowPriorityMode: this.lowPriorityMode,
    };
  }

  private async getCurrentUsage(): Promise<ResourceUsage> {
    // CPU使用率
    const load = loadavg()[0];
    const cpuCount = cpus().length;
    const cpuPercent = (load / cpuCount) * 100;

    // メモリ使用率
    const totalMem = totalmem();
    const freeMem = freemem();
    const usedMem = totalMem - freeMem;
    const memoryMB = usedMem / (1024 * 1024);
    const memoryPercent = (usedMem / totalMem) * 100;

    // プロセス数
    let processCount = 0;
    try {
      const output = execSync(
        'ps -u $(whoami) --no-headers | wc -l',
        { encoding: 'utf-8' }
      );
      processCount = parseInt(output.trim(), 10);
    } catch {
      // ignore
    }

    return {
      cpuPercent,
      memoryMB,
      memoryPercent,
      diskGB: 0,
      diskPercent: 0,
      networkMbps: 0,
      processCount,
    };
  }

  private async getSystemLoad(): Promise<{ high: boolean; moderate: boolean }> {
    const load = loadavg()[0];
    const cpuCount = cpus().length;
    const loadPercent = (load / cpuCount) * 100;

    return {
      high: loadPercent > 80,
      moderate: loadPercent > 50,
    };
  }

  private async throttle(reason: string): Promise<void> {
    if (this.throttled) return;

    this.throttled = true;
    logger.info('Throttling enabled', { reason });

    // 短い遅延を挿入してCPU負荷を下げる
    await sleep(1000);
  }

  private async reduceMemory(): Promise<void> {
    logger.info('Attempting to reduce memory usage');

    // ガベージコレクションを促進
    if (global.gc) {
      global.gc();
    }
  }

  async enterLowPriorityMode(): Promise<void> {
    if (this.lowPriorityMode) return;

    this.lowPriorityMode = true;
    logger.info('Entering low priority mode');

    // nice値を上げる（LinuxのみでPID自体は変更できないためログのみ）
    try {
      execSync(`renice +10 -p ${process.pid}`, { stdio: 'ignore' });
    } catch {
      // 権限がない場合は無視
    }
  }

  async exitLowPriorityMode(): Promise<void> {
    if (!this.lowPriorityMode) return;

    this.lowPriorityMode = false;
    logger.info('Exiting low priority mode');

    try {
      execSync(`renice 0 -p ${process.pid}`, { stdio: 'ignore' });
    } catch {
      // ignore
    }
  }

  adjustByTime(): void {
    const hour = new Date().getHours();

    // 深夜（2-6時）は控えめに
    if (hour >= 2 && hour < 6) {
      this.limits.maxCpuPercent = 10;
      this.limits.maxMemoryMB = 1024;
      logger.info('Night mode: reduced resource limits');
    } else {
      this.limits.maxCpuPercent = 30;
      this.limits.maxMemoryMB = 2048;
    }
  }

  getLimits(): ResourceLimits {
    return { ...this.limits };
  }

  setLimits(limits: Partial<ResourceLimits>): void {
    Object.assign(this.limits, limits);
    logger.info('Resource limits updated', this.limits);
  }

  isLowPriority(): boolean {
    return this.lowPriorityMode;
  }

  isThrottled(): boolean {
    return this.throttled;
  }

  resetThrottle(): void {
    this.throttled = false;
  }
}

let instance: ResourceManager | null = null;

export function getResourceManager(limits?: Partial<ResourceLimits>): ResourceManager {
  if (!instance) {
    instance = new ResourceManager(limits);
  }
  return instance;
}
