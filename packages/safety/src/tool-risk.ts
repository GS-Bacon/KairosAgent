import { ToolStatus, getLogger, sleep } from '@auto-claude/core';
import type { ToolHealth } from '@auto-claude/core';
import { spawn } from 'child_process';

const logger = getLogger('safety:tool-risk');

export interface ToolRiskConfig {
  checkIntervalMs: number;
  maxRecoveryAttempts: number;
  recoveryDelayMs: number;
}

export interface ToolCheckResult {
  tool: string;
  status: ToolStatus;
  latencyMs: number;
  error?: string;
}

export class ToolRiskMonitor {
  private config: ToolRiskConfig;
  private inSafeMode: boolean = false;
  private recoveryAttempts: number = 0;
  private lastHealth: ToolHealth | null = null;

  constructor(config: Partial<ToolRiskConfig> = {}) {
    this.config = {
      checkIntervalMs: config.checkIntervalMs ?? 10 * 60 * 1000,
      maxRecoveryAttempts: config.maxRecoveryAttempts ?? 3,
      recoveryDelayMs: config.recoveryDelayMs ?? 5 * 60 * 1000,
    };
    logger.info('ToolRiskMonitor initialized');
  }

  async checkToolHealth(): Promise<ToolHealth> {
    const [claudeCode, browser, network, discord] = await Promise.all([
      this.checkClaudeCode(),
      this.checkBrowser(),
      this.checkNetwork(),
      this.checkDiscord(),
    ]);

    const health: ToolHealth = {
      claudeCode: claudeCode.status,
      browser: browser.status,
      network: network.status,
      discord: discord.status,
    };

    this.lastHealth = health;

    // Claude Code が利用不可の場合
    if (health.claudeCode === ToolStatus.UNAVAILABLE) {
      await this.handleClaudeCodeFailure();
    }

    logger.info('Tool health check completed', health);
    return health;
  }

  private async checkClaudeCode(): Promise<ToolCheckResult> {
    const start = Date.now();

    return new Promise((resolve) => {
      const proc = spawn('claude', ['--version'], {
        timeout: 10000,
      });

      let output = '';
      proc.stdout.on('data', (data) => {
        output += data.toString();
      });

      proc.on('close', (code) => {
        const latencyMs = Date.now() - start;
        if (code === 0) {
          resolve({
            tool: 'claude-code',
            status: ToolStatus.HEALTHY,
            latencyMs,
          });
        } else {
          resolve({
            tool: 'claude-code',
            status: ToolStatus.DEGRADED,
            latencyMs,
            error: `Exit code: ${code}`,
          });
        }
      });

      proc.on('error', (error) => {
        resolve({
          tool: 'claude-code',
          status: ToolStatus.UNAVAILABLE,
          latencyMs: Date.now() - start,
          error: error.message,
        });
      });
    });
  }

  private async checkBrowser(): Promise<ToolCheckResult> {
    const start = Date.now();

    try {
      // Playwrightの存在チェック（実際のブラウザ起動はコストが高いため省略）
      const { execSync } = await import('child_process');
      execSync('which chromium || which google-chrome || which chromium-browser', {
        encoding: 'utf-8',
        timeout: 5000,
      });

      return {
        tool: 'browser',
        status: ToolStatus.HEALTHY,
        latencyMs: Date.now() - start,
      };
    } catch (error) {
      return {
        tool: 'browser',
        status: ToolStatus.DEGRADED,
        latencyMs: Date.now() - start,
        error: 'Browser binary not found',
      };
    }
  }

  private async checkNetwork(): Promise<ToolCheckResult> {
    const start = Date.now();

    try {
      const { execSync } = await import('child_process');
      execSync('curl -s --max-time 5 -o /dev/null https://api.anthropic.com', {
        timeout: 10000,
      });

      return {
        tool: 'network',
        status: ToolStatus.HEALTHY,
        latencyMs: Date.now() - start,
      };
    } catch (error) {
      return {
        tool: 'network',
        status: ToolStatus.DEGRADED,
        latencyMs: Date.now() - start,
        error: 'Network connectivity issue',
      };
    }
  }

  private async checkDiscord(): Promise<ToolCheckResult> {
    const start = Date.now();

    try {
      const { execSync } = await import('child_process');
      execSync('curl -s --max-time 5 -o /dev/null https://discord.com/api/v10/gateway', {
        timeout: 10000,
      });

      return {
        tool: 'discord',
        status: ToolStatus.HEALTHY,
        latencyMs: Date.now() - start,
      };
    } catch (error) {
      return {
        tool: 'discord',
        status: ToolStatus.DEGRADED,
        latencyMs: Date.now() - start,
        error: 'Discord API connectivity issue',
      };
    }
  }

  private async handleClaudeCodeFailure(): Promise<void> {
    logger.critical('Claude Code is unavailable');

    if (!this.inSafeMode) {
      await this.enterSafeMode();
    }

    await this.attemptRecovery();
  }

  async enterSafeMode(): Promise<void> {
    this.inSafeMode = true;
    logger.warn('Entering safe mode due to tool failure');

    // セーフモードの状態を保存（通知パッケージが利用可能な場合）
  }

  async exitSafeMode(): Promise<void> {
    this.inSafeMode = false;
    this.recoveryAttempts = 0;
    logger.info('Exiting safe mode');
  }

  private async attemptRecovery(): Promise<boolean> {
    if (this.recoveryAttempts >= this.config.maxRecoveryAttempts) {
      logger.error('Max recovery attempts reached', {
        attempts: this.recoveryAttempts,
      });
      return false;
    }

    this.recoveryAttempts++;
    logger.info('Attempting recovery', { attempt: this.recoveryAttempts });

    await sleep(this.config.recoveryDelayMs);

    const health = await this.checkClaudeCode();

    if (health.status === ToolStatus.HEALTHY) {
      logger.info('Recovery successful');
      await this.exitSafeMode();
      return true;
    }

    return this.attemptRecovery();
  }

  isInSafeMode(): boolean {
    return this.inSafeMode;
  }

  getLastHealth(): ToolHealth | null {
    return this.lastHealth;
  }
}

let instance: ToolRiskMonitor | null = null;

export function getToolRiskMonitor(config?: Partial<ToolRiskConfig>): ToolRiskMonitor {
  if (!instance) {
    instance = new ToolRiskMonitor(config);
  }
  return instance;
}
