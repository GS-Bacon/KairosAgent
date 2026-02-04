import { SystemState, getLogger } from '@auto-claude/core';
import type { SystemHealth } from '@auto-claude/core';
import { getSystemRiskMonitor } from '@auto-claude/safety';
import { getToolRiskMonitor } from '@auto-claude/safety';
import { getResourceManager } from '@auto-claude/safety';
import { getDiscordNotifier } from '@auto-claude/notification';
import { getMemoryManager } from '@auto-claude/memory';

const logger = getLogger('orchestrator:heartbeat');

export interface HeartbeatStatus {
  timestamp: Date;
  health: SystemHealth;
  uptime: number;
  version: string;
}

export class HeartbeatManager {
  private startTime: Date;
  private lastHeartbeat: Date | null = null;
  private systemRisk = getSystemRiskMonitor();
  private toolRisk = getToolRiskMonitor();
  private resourceManager = getResourceManager();
  private discord = getDiscordNotifier();
  private memory = getMemoryManager();
  private consecutiveFailures: number = 0;

  constructor() {
    this.startTime = new Date();
    logger.info('HeartbeatManager initialized');
  }

  async beat(): Promise<HeartbeatStatus> {
    logger.debug('Heartbeat starting');

    try {
      // システムチェック
      const systemStatus = await this.systemRisk.checkSystem();

      // ツールチェック
      const toolHealth = await this.toolRisk.checkToolHealth();

      // リソースチェック
      const resourceStatus = await this.resourceManager.checkResources();

      const health: SystemHealth = {
        state: this.determineState(systemStatus.state, toolHealth),
        uptime: this.getUptimeSeconds(),
        lastHeartbeat: this.lastHeartbeat ?? new Date(),
        resources: systemStatus.resources,
        tools: toolHealth,
        errors: systemStatus.issues,
        warnings: systemStatus.recommendations,
      };

      this.lastHeartbeat = new Date();
      this.consecutiveFailures = 0;

      // ステータスを保存
      await this.saveStatus(health);

      // 問題がある場合は通知
      if (health.state !== SystemState.HEALTHY) {
        await this.notifyStatus(health);
      }

      logger.info('Heartbeat completed', {
        state: health.state,
        uptime: health.uptime,
      });

      return {
        timestamp: this.lastHeartbeat,
        health,
        uptime: this.getUptimeSeconds(),
        version: '0.1.0',
      };
    } catch (error) {
      this.consecutiveFailures++;
      logger.error('Heartbeat failed', { error, failures: this.consecutiveFailures });

      if (this.consecutiveFailures >= 3) {
        await this.discord.sendCritical({
          title: 'ハートビート障害',
          description: `連続${this.consecutiveFailures}回のハートビート失敗`,
        });
      }

      throw error;
    }
  }

  private determineState(
    systemState: SystemState,
    toolHealth: SystemHealth['tools']
  ): SystemState {
    // ツールが利用不可なら安全モード
    if (toolHealth.claudeCode === 'unavailable') {
      return SystemState.SAFE_MODE;
    }

    // システムが既に安全モードまたは停止なら維持
    if (
      systemState === SystemState.SAFE_MODE ||
      systemState === SystemState.STOPPED
    ) {
      return systemState;
    }

    // ツールが劣化していれば劣化状態
    if (
      toolHealth.claudeCode === 'degraded' ||
      toolHealth.network === 'degraded'
    ) {
      return SystemState.DEGRADED;
    }

    return systemState;
  }

  private async saveStatus(health: SystemHealth): Promise<void> {
    const statusFile = 'SYSTEM_STATUS.json';
    await this.memory.writeJson(statusFile, {
      timestamp: new Date().toISOString(),
      health,
      uptime: this.getUptimeSeconds(),
    });
  }

  private async notifyStatus(health: SystemHealth): Promise<void> {
    const stateMessages: Record<SystemState, string> = {
      [SystemState.HEALTHY]: 'システム正常',
      [SystemState.DEGRADED]: 'システム劣化',
      [SystemState.SAFE_MODE]: '安全モード',
      [SystemState.STOPPED]: 'システム停止',
    };

    const type = health.state === SystemState.SAFE_MODE ? 'critical' : 'warning';

    await this.discord.send({
      type,
      title: stateMessages[health.state],
      fields: [
        {
          name: 'エラー',
          value: health.errors.join('\n') || 'なし',
        },
        {
          name: '警告',
          value: health.warnings.join('\n') || 'なし',
        },
      ],
    });
  }

  getUptimeSeconds(): number {
    return Math.floor((Date.now() - this.startTime.getTime()) / 1000);
  }

  getLastHeartbeat(): Date | null {
    return this.lastHeartbeat;
  }

  getConsecutiveFailures(): number {
    return this.consecutiveFailures;
  }
}
