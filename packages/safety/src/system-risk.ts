import { SystemState, RiskLevel, getLogger } from '@auto-claude/core';
import type { ResourceUsage } from '@auto-claude/core';
import { execSync } from 'child_process';
import { freemem, totalmem, cpus, loadavg } from 'os';
import { statfsSync } from 'fs';

const logger = getLogger('safety:system-risk');

export interface SystemRiskConfig {
  maxCpuPercent: number;
  maxMemoryPercent: number;
  maxDiskPercent: number;
  checkIntervalMs: number;
}

export interface SystemRiskStatus {
  state: SystemState;
  riskLevel: RiskLevel;
  resources: ResourceUsage;
  issues: string[];
  recommendations: string[];
}

export class SystemRiskMonitor {
  private config: SystemRiskConfig;
  private lastCheck: Date | null = null;

  constructor(config: Partial<SystemRiskConfig> = {}) {
    this.config = {
      maxCpuPercent: config.maxCpuPercent ?? 30,
      maxMemoryPercent: config.maxMemoryPercent ?? 80,
      maxDiskPercent: config.maxDiskPercent ?? 80,
      checkIntervalMs: config.checkIntervalMs ?? 60000,
    };
    logger.info('SystemRiskMonitor initialized', this.config);
  }

  async checkSystem(): Promise<SystemRiskStatus> {
    const resources = await this.getResourceUsage();
    const issues: string[] = [];
    const recommendations: string[] = [];
    let riskLevel = RiskLevel.LOW;

    // CPU チェック
    if (resources.cpuPercent > this.config.maxCpuPercent) {
      issues.push(`CPU使用率が高い: ${resources.cpuPercent.toFixed(1)}%`);
      recommendations.push('重いタスクを延期してください');
      riskLevel = Math.max(riskLevel, RiskLevel.MEDIUM);
    }

    // メモリチェック
    if (resources.memoryPercent > this.config.maxMemoryPercent) {
      issues.push(`メモリ使用率が高い: ${resources.memoryPercent.toFixed(1)}%`);
      recommendations.push('メモリを解放してください');
      riskLevel = Math.max(riskLevel, RiskLevel.HIGH);
    }

    // ディスクチェック
    if (resources.diskPercent > this.config.maxDiskPercent) {
      issues.push(`ディスク使用率が高い: ${resources.diskPercent.toFixed(1)}%`);
      recommendations.push('不要なファイルを削除してください');
      riskLevel = Math.max(riskLevel, RiskLevel.HIGH);
    }

    // プロセス数チェック
    if (resources.processCount > 100) {
      issues.push(`プロセス数が多い: ${resources.processCount}`);
      riskLevel = Math.max(riskLevel, RiskLevel.MEDIUM);
    }

    const state = this.determineState(riskLevel, issues);
    this.lastCheck = new Date();

    const status: SystemRiskStatus = {
      state,
      riskLevel,
      resources,
      issues,
      recommendations,
    };

    if (issues.length > 0) {
      logger.warn('System issues detected', status);
    } else {
      logger.debug('System check passed', { resources });
    }

    return status;
  }

  private async getResourceUsage(): Promise<ResourceUsage> {
    // CPU使用率（ロードアベレージベース）
    const load = loadavg()[0];
    const cpuCount = cpus().length;
    const cpuPercent = (load / cpuCount) * 100;

    // メモリ使用率
    const totalMem = totalmem();
    const freeMem = freemem();
    const usedMem = totalMem - freeMem;
    const memoryMB = usedMem / (1024 * 1024);
    const memoryPercent = (usedMem / totalMem) * 100;

    // ディスク使用率
    let diskGB = 0;
    let diskPercent = 0;
    try {
      const stats = statfsSync('/home');
      const totalDisk = stats.blocks * stats.bsize;
      const freeDisk = stats.bfree * stats.bsize;
      const usedDisk = totalDisk - freeDisk;
      diskGB = usedDisk / (1024 * 1024 * 1024);
      diskPercent = (usedDisk / totalDisk) * 100;
    } catch (error) {
      logger.warn('Failed to get disk stats', { error });
    }

    // プロセス数
    let processCount = 0;
    try {
      const output = execSync('ps aux | wc -l', { encoding: 'utf-8' });
      processCount = parseInt(output.trim(), 10) - 1;
    } catch (error) {
      logger.warn('Failed to get process count', { error });
    }

    return {
      cpuPercent,
      memoryMB,
      memoryPercent,
      diskGB,
      diskPercent,
      networkMbps: 0,
      processCount,
    };
  }

  private determineState(riskLevel: RiskLevel, issues: string[]): SystemState {
    if (riskLevel >= RiskLevel.CRITICAL) {
      return SystemState.SAFE_MODE;
    }
    if (riskLevel >= RiskLevel.HIGH || issues.length >= 2) {
      return SystemState.DEGRADED;
    }
    return SystemState.HEALTHY;
  }

  getLastCheckTime(): Date | null {
    return this.lastCheck;
  }
}

let instance: SystemRiskMonitor | null = null;

export function getSystemRiskMonitor(config?: Partial<SystemRiskConfig>): SystemRiskMonitor {
  if (!instance) {
    instance = new SystemRiskMonitor(config);
  }
  return instance;
}
