import { getLogger, generateId, getRateLimitManager } from '@auto-claude/core';
import { spawn, ChildProcess } from 'child_process';

const logger = getLogger('ai-router:claude-cli');

export interface ClaudeTask {
  prompt: string;
  allowedTools?: string[];
  timeout?: number;
  workingDir?: string;
  outputFormat?: 'text' | 'json' | 'stream-json';
}

export interface ClaudeResult {
  success: boolean;
  output: string;
  exitCode: number | null;
  duration: number;
  error?: string;
  isRateLimited?: boolean;
}

export interface ClaudeStreamEvent {
  type: 'text' | 'tool_use' | 'result' | 'error';
  content?: string;
  tool?: string;
  input?: unknown;
}

export class ClaudeCLI {
  private defaultTimeout: number;
  private defaultAllowedTools: string[];
  private runningProcesses: Map<string, ChildProcess> = new Map();

  constructor(options: {
    defaultTimeout?: number;
    defaultAllowedTools?: string[];
  } = {}) {
    this.defaultTimeout = options.defaultTimeout ?? 5 * 60 * 1000;
    this.defaultAllowedTools = options.defaultAllowedTools ?? [
      'Read',
      'Write',
      'Edit',
      'Bash',
      'Glob',
      'Grep',
      'WebFetch',
      'WebSearch',
    ];
    logger.info('ClaudeCLI initialized');
  }

  async executeTask(task: ClaudeTask): Promise<ClaudeResult> {
    const taskId = generateId('claude');
    const startTime = Date.now();

    logger.info('Executing Claude task', {
      taskId,
      prompt: task.prompt.slice(0, 100) + '...',
      allowedTools: task.allowedTools ?? this.defaultAllowedTools,
    });

    return new Promise((resolve) => {
      const args = this.buildArgs(task);

      const proc = spawn('claude', args, {
        cwd: task.workingDir ?? process.cwd(),
        env: { ...process.env },
        stdio: ['pipe', 'pipe', 'pipe'],
      });

      this.runningProcesses.set(taskId, proc);

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
        logger.warn('Claude task timed out', { taskId });
      }, task.timeout ?? this.defaultTimeout);

      proc.on('close', (code) => {
        clearTimeout(timeout);
        this.runningProcesses.delete(taskId);

        const duration = Date.now() - startTime;

        if (code === 0) {
          logger.info('Claude task completed', { taskId, duration });
          resolve({
            success: true,
            output: stdout,
            exitCode: code,
            duration,
          });
        } else {
          logger.error('Claude task failed', { taskId, code, stderr });
          const isRateLimited = this.detectRateLimit(stdout, stderr);
          if (isRateLimited) {
            getRateLimitManager().recordRateLimitHit('claude-cli');
          }
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
        logger.error('Claude task error', { taskId, error: error.message });

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

  private buildArgs(task: ClaudeTask): string[] {
    const args: string[] = ['-p', task.prompt];

    if (task.outputFormat) {
      args.push('--output-format', task.outputFormat);
    }

    const tools = task.allowedTools ?? this.defaultAllowedTools;
    if (tools.length > 0) {
      args.push('--allowedTools', ...tools);
    }

    return args;
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

  async executeWithStreaming(
    task: ClaudeTask,
    onEvent: (event: ClaudeStreamEvent) => void
  ): Promise<ClaudeResult> {
    const taskId = generateId('claude-stream');
    const startTime = Date.now();

    return new Promise((resolve) => {
      const args = this.buildArgs({
        ...task,
        outputFormat: 'stream-json',
      });

      const proc = spawn('claude', args, {
        cwd: task.workingDir ?? process.cwd(),
        env: { ...process.env },
        stdio: ['pipe', 'pipe', 'pipe'],
      });

      this.runningProcesses.set(taskId, proc);

      let fullOutput = '';
      let buffer = '';

      proc.stdout.on('data', (data) => {
        buffer += data.toString();
        fullOutput += data.toString();

        // JSONLをパース
        const lines = buffer.split('\n');
        buffer = lines.pop() ?? '';

        for (const line of lines) {
          if (line.trim()) {
            try {
              const event = JSON.parse(line);
              onEvent(this.parseStreamEvent(event));
            } catch {
              // 非JSONは無視
            }
          }
        }
      });

      const timeout = setTimeout(() => {
        proc.kill('SIGTERM');
      }, task.timeout ?? this.defaultTimeout);

      proc.on('close', (code) => {
        clearTimeout(timeout);
        this.runningProcesses.delete(taskId);

        resolve({
          success: code === 0,
          output: fullOutput,
          exitCode: code,
          duration: Date.now() - startTime,
        });
      });

      proc.on('error', (error) => {
        clearTimeout(timeout);
        this.runningProcesses.delete(taskId);

        resolve({
          success: false,
          output: fullOutput,
          exitCode: null,
          duration: Date.now() - startTime,
          error: error.message,
        });
      });
    });
  }

  private parseStreamEvent(raw: unknown): ClaudeStreamEvent {
    const event = raw as Record<string, unknown>;

    if (event.type === 'assistant' && event.message) {
      const message = event.message as Record<string, unknown>;
      const content = message.content as Array<Record<string, unknown>>;

      if (content && content[0]) {
        const block = content[0];
        if (block.type === 'text') {
          return { type: 'text', content: block.text as string };
        }
        if (block.type === 'tool_use') {
          return {
            type: 'tool_use',
            tool: block.name as string,
            input: block.input,
          };
        }
      }
    }

    if (event.type === 'result') {
      return { type: 'result', content: JSON.stringify(event) };
    }

    return { type: 'text', content: JSON.stringify(event) };
  }

  cancelTask(taskId: string): boolean {
    const proc = this.runningProcesses.get(taskId);
    if (proc) {
      proc.kill('SIGTERM');
      this.runningProcesses.delete(taskId);
      logger.info('Claude task cancelled', { taskId });
      return true;
    }
    return false;
  }

  cancelAllTasks(): void {
    for (const [taskId, proc] of this.runningProcesses.entries()) {
      proc.kill('SIGTERM');
      logger.info('Claude task cancelled', { taskId });
    }
    this.runningProcesses.clear();
  }

  getRunningTaskCount(): number {
    return this.runningProcesses.size;
  }
}

let instance: ClaudeCLI | null = null;

export function getClaudeCLI(options?: {
  defaultTimeout?: number;
  defaultAllowedTools?: string[];
}): ClaudeCLI {
  if (!instance) {
    instance = new ClaudeCLI(options);
  }
  return instance;
}
