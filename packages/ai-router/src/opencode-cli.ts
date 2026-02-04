import { getLogger, generateId } from '@auto-claude/core';
import { spawn, ChildProcess } from 'child_process';

const logger = getLogger('ai-router:opencode-cli');

export interface OpencodeTask {
  prompt: string;
  timeout?: number;
  workingDir?: string;
}

export interface OpencodeResult {
  success: boolean;
  output: string;
  exitCode: number | null;
  duration: number;
  error?: string;
  isRateLimited?: boolean;
}

export class OpencodeCLI {
  private defaultTimeout: number;
  private runningProcesses: Map<string, ChildProcess> = new Map();

  constructor(options: { defaultTimeout?: number } = {}) {
    // GLM-4.7は高速なので、デフォルトタイムアウトは3分
    this.defaultTimeout = options.defaultTimeout ?? 3 * 60 * 1000;
    logger.info('OpencodeCLI initialized', { defaultTimeout: this.defaultTimeout });
  }

  async executeTask(task: OpencodeTask): Promise<OpencodeResult> {
    const taskId = generateId('opencode');
    const startTime = Date.now();

    logger.info('Executing Opencode task', {
      taskId,
      prompt: task.prompt.slice(0, 100) + (task.prompt.length > 100 ? '...' : ''),
    });

    return new Promise((resolve) => {
      const args = this.buildArgs(task);

      const proc = spawn('opencode', args, {
        cwd: task.workingDir ?? process.cwd(),
        env: { ...process.env },
        stdio: ['pipe', 'pipe', 'pipe'],
      });

      this.runningProcesses.set(taskId, proc);

      // stdinを閉じないとプロセスが終了しない
      proc.stdin.end();

      let stdout = '';
      let stderr = '';

      proc.stdout.on('data', (data) => {
        stdout += data.toString();
      });

      proc.stderr.on('data', (data) => {
        stderr += data.toString();
      });

      const timeout = setTimeout(() => {
        proc.kill('SIGTERM');
        logger.warn('Opencode task timed out', { taskId });
      }, task.timeout ?? this.defaultTimeout);

      proc.on('close', (code) => {
        clearTimeout(timeout);
        this.runningProcesses.delete(taskId);

        const duration = Date.now() - startTime;

        if (code === 0) {
          logger.info('Opencode task completed', { taskId, duration });
          resolve({
            success: true,
            output: stdout,
            exitCode: code,
            duration,
          });
        } else {
          logger.error('Opencode task failed', { taskId, code, stderr });
          const isRateLimited = this.detectRateLimit(stdout, stderr);
          resolve({
            success: false,
            output: stdout,
            exitCode: code,
            duration,
            error: stderr || `Process exited with code ${code}`,
            isRateLimited,
          });
        }
      });

      proc.on('error', (error) => {
        clearTimeout(timeout);
        this.runningProcesses.delete(taskId);

        const duration = Date.now() - startTime;
        logger.error('Opencode task error', { taskId, error: error.message });

        resolve({
          success: false,
          output: '',
          exitCode: null,
          duration,
          error: error.message,
        });
      });

    });
  }

  private buildArgs(task: OpencodeTask): string[] {
    // opencode CLIの引数形式に合わせる
    // opencode run "prompt" で実行
    return ['run', task.prompt];
  }

  private detectRateLimit(output: string, error: string): boolean {
    const combined = `${output} ${error}`.toLowerCase();
    const patterns = [
      /rate limit/i,
      /too many requests/i,
      /429/i,
      /quota exceeded/i,
      /overloaded/i,
      /capacity/i,
    ];
    return patterns.some((p) => p.test(combined));
  }

  cancelTask(taskId: string): boolean {
    const proc = this.runningProcesses.get(taskId);
    if (proc) {
      proc.kill('SIGTERM');
      this.runningProcesses.delete(taskId);
      logger.info('Opencode task cancelled', { taskId });
      return true;
    }
    return false;
  }

  cancelAllTasks(): void {
    for (const [taskId, proc] of this.runningProcesses.entries()) {
      proc.kill('SIGTERM');
      logger.info('Opencode task cancelled', { taskId });
    }
    this.runningProcesses.clear();
  }

  getRunningTaskCount(): number {
    return this.runningProcesses.size;
  }
}

let instance: OpencodeCLI | null = null;

export function getOpencodeCLI(options?: { defaultTimeout?: number }): OpencodeCLI {
  if (!instance) {
    instance = new OpencodeCLI(options);
  }
  return instance;
}
