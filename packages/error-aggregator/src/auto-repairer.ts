/**
 * 自動修正エンジン
 * Claude CLI を使用してエラーを自動修正する
 */

import { spawn } from 'node:child_process';
import { join } from 'node:path';
import type {
  RepairTask,
  RepairAttemptResult,
  AutoRepairConfig,
  AggregatedError,
} from './types.js';
import { getRepairQueue } from './repair-queue.js';
import { getRepairCircuitBreaker } from './circuit-breaker.js';
import { getErrorAggregator } from './aggregator.js';

const DEFAULT_CONFIG: AutoRepairConfig = {
  enabled: true,
  maxConcurrentRepairs: 1,
  defaultMaxAttempts: 3,
  claudeCliPath: 'claude',
  workingDirectory: process.cwd(),
  timeoutMs: 10 * 60 * 1000, // 10分
};

/**
 * AutoRepairer クラス
 * エラーの自動修正を実行する
 */
export class AutoRepairer {
  private config: AutoRepairConfig;
  private isProcessing = false;
  private currentProcess: ReturnType<typeof spawn> | null = null;

  constructor(config: Partial<AutoRepairConfig> = {}) {
    this.config = { ...DEFAULT_CONFIG, ...config };
  }

  /**
   * 設定を更新
   */
  updateConfig(config: Partial<AutoRepairConfig>): void {
    this.config = { ...this.config, ...config };
  }

  /**
   * 設定を取得
   */
  getConfig(): AutoRepairConfig {
    return { ...this.config };
  }

  /**
   * 自動修正が有効かどうか
   */
  isEnabled(): boolean {
    return this.config.enabled;
  }

  /**
   * 現在処理中かどうか
   */
  isRunning(): boolean {
    return this.isProcessing;
  }

  /**
   * Claude CLI を使用して修正を実行
   */
  private async executeClaudeCli(prompt: string): Promise<{ success: boolean; output: string; error?: string }> {
    return new Promise((resolve) => {
      const args = [
        '--print',
        '--dangerously-skip-permissions',
        prompt,
      ];

      const startTime = Date.now();
      let stdout = '';
      let stderr = '';
      let timedOut = false;

      this.currentProcess = spawn(this.config.claudeCliPath, args, {
        cwd: this.config.workingDirectory,
        env: {
          ...process.env,
          CLAUDE_CODE_ENTRYPOINT: 'auto-repairer',
        },
        stdio: ['pipe', 'pipe', 'pipe'],
      });

      const timeoutId = setTimeout(() => {
        timedOut = true;
        this.currentProcess?.kill('SIGTERM');
      }, this.config.timeoutMs);

      this.currentProcess.stdout?.on('data', (data) => {
        stdout += data.toString();
      });

      this.currentProcess.stderr?.on('data', (data) => {
        stderr += data.toString();
      });

      this.currentProcess.on('close', (code) => {
        clearTimeout(timeoutId);
        this.currentProcess = null;

        if (timedOut) {
          resolve({
            success: false,
            output: stdout,
            error: `Repair timed out after ${this.config.timeoutMs}ms`,
          });
          return;
        }

        if (code === 0) {
          resolve({
            success: true,
            output: stdout,
          });
        } else {
          resolve({
            success: false,
            output: stdout,
            error: stderr || `Process exited with code ${code}`,
          });
        }
      });

      this.currentProcess.on('error', (err) => {
        clearTimeout(timeoutId);
        this.currentProcess = null;
        resolve({
          success: false,
          output: '',
          error: `Failed to spawn process: ${err.message}`,
        });
      });
    });
  }

  /**
   * 単一のタスクを処理
   */
  async processTask(task: RepairTask): Promise<RepairAttemptResult> {
    const startTime = Date.now();

    const result = await this.executeClaudeCli(task.prompt);

    const attemptResult: RepairAttemptResult = {
      timestamp: new Date().toISOString(),
      success: result.success,
      prompt: task.prompt,
      output: result.output,
      error: result.error,
      durationMs: Date.now() - startTime,
    };

    return attemptResult;
  }

  /**
   * キューから次のタスクを取得して処理
   */
  async processNext(): Promise<RepairAttemptResult | null> {
    if (!this.config.enabled) {
      console.log('AutoRepairer is disabled');
      return null;
    }

    if (this.isProcessing) {
      console.log('AutoRepairer is already processing');
      return null;
    }

    const circuitBreaker = getRepairCircuitBreaker();
    if (!circuitBreaker.canAttemptRepair()) {
      const remainingMs = circuitBreaker.getRemainingCooldownMs();
      console.log(`Circuit breaker is open. Cooldown remaining: ${Math.ceil(remainingMs / 1000)}s`);
      return null;
    }

    const queue = getRepairQueue();
    const task = queue.dequeue();

    if (!task) {
      return null;
    }

    this.isProcessing = true;

    try {
      console.log(`Processing repair task: ${task.id} for error: ${task.errorId}`);
      const result = await this.processTask(task);

      queue.complete(task.id, result);

      if (result.success) {
        console.log(`Repair successful for task: ${task.id}`);
      } else {
        console.log(`Repair failed for task: ${task.id}: ${result.error}`);
      }

      return result;
    } finally {
      this.isProcessing = false;
    }
  }

  /**
   * キュー内の全タスクを処理
   */
  async processAll(): Promise<RepairAttemptResult[]> {
    const results: RepairAttemptResult[] = [];

    while (true) {
      const result = await this.processNext();
      if (!result) break;
      results.push(result);
    }

    return results;
  }

  /**
   * 特定のエラーを直接修正
   */
  async repairError(errorId: string, customPrompt?: string): Promise<RepairAttemptResult | null> {
    const aggregator = getErrorAggregator();
    const error = aggregator.getError(errorId);

    if (!error) {
      console.error(`Error not found: ${errorId}`);
      return null;
    }

    const queue = getRepairQueue();
    const task = queue.enqueue(error, 'urgent', customPrompt);

    if (!task) {
      console.error(`Failed to enqueue repair task for error: ${errorId}`);
      return null;
    }

    // すぐに処理
    return this.processNext();
  }

  /**
   * 新規エラーを自動的にキューに追加
   */
  async queueNewErrors(): Promise<number> {
    const aggregator = getErrorAggregator();
    const queue = getRepairQueue();
    const circuitBreaker = getRepairCircuitBreaker();

    const newErrors = aggregator.getErrors({ statuses: ['new'] });
    let queued = 0;

    for (const error of newErrors) {
      if (!circuitBreaker.canAttemptRepair(error.source)) {
        continue;
      }

      if (!circuitBreaker.canAttemptRepairForError(error.id, error.repairAttempts.length)) {
        continue;
      }

      const task = queue.enqueue(error);
      if (task) {
        queued++;
      }
    }

    return queued;
  }

  /**
   * 自動修正サイクルを実行（スケジューラから呼び出される）
   */
  async runCycle(): Promise<{ queued: number; processed: number; results: RepairAttemptResult[] }> {
    if (!this.config.enabled) {
      return { queued: 0, processed: 0, results: [] };
    }

    // 新規エラーをキューに追加
    const queued = await this.queueNewErrors();

    // キューを処理
    const results = await this.processAll();

    return {
      queued,
      processed: results.length,
      results,
    };
  }

  /**
   * 現在の処理をキャンセル
   */
  cancel(): void {
    if (this.currentProcess) {
      this.currentProcess.kill('SIGTERM');
    }
  }

  /**
   * 有効/無効を切り替え
   */
  setEnabled(enabled: boolean): void {
    this.config.enabled = enabled;
  }
}

// シングルトンインスタンス
let instance: AutoRepairer | null = null;

export function getAutoRepairer(): AutoRepairer {
  if (!instance) {
    instance = new AutoRepairer();
  }
  return instance;
}
