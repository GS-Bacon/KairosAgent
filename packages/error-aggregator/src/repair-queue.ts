/**
 * 修正タスクキュー
 * 修正タスクの優先度管理、重複チェック
 */

import { existsSync, readFileSync, writeFileSync, mkdirSync, appendFileSync } from 'node:fs';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import type {
  RepairTask,
  RepairPriority,
  RepairQueueState,
  AggregatedError,
  RepairAttemptResult,
  ErrorSeverity,
} from './types.js';
import { getErrorAggregator } from './aggregator.js';
import { getRepairCircuitBreaker } from './circuit-breaker.js';

const WORKSPACE_DIR = process.env.ERROR_AGGREGATOR_WORKSPACE ||
  join(process.cwd(), 'workspace', 'errors');

const QUEUE_FILE = join(WORKSPACE_DIR, 'repair-queue.json');
const HISTORY_FILE = join(WORKSPACE_DIR, 'repair-history.jsonl');

/**
 * 重要度から優先度へのマッピング
 */
function severityToPriority(severity: ErrorSeverity): RepairPriority {
  switch (severity) {
    case 'critical': return 'urgent';
    case 'high': return 'high';
    case 'medium': return 'normal';
    case 'low': return 'low';
    default: return 'normal';
  }
}

/**
 * 優先度の数値化（ソート用）
 */
function priorityToNumber(priority: RepairPriority): number {
  switch (priority) {
    case 'urgent': return 4;
    case 'high': return 3;
    case 'normal': return 2;
    case 'low': return 1;
    default: return 0;
  }
}

/**
 * 修正プロンプトを生成
 */
function generateRepairPrompt(error: AggregatedError): string {
  const contextStr = Object.entries(error.context)
    .map(([k, v]) => `- ${k}: ${JSON.stringify(v)}`)
    .join('\n');

  const previousAttempts = error.repairAttempts.length > 0
    ? `\n\n## 過去の修正試行 (${error.repairAttempts.length}回失敗)\n${error.repairAttempts.map((a, i) => `### 試行${i + 1}\nプロンプト: ${a.prompt}\nエラー: ${a.error || 'N/A'}`).join('\n')}`
    : '';

  return `以下のエラーを自動修正してください。

## エラー情報
- ID: ${error.id}
- 発生元: ${error.source}
- カテゴリ: ${error.category}
- 重要度: ${error.severity}
- メッセージ: ${error.message}
${error.stack ? `\n## スタックトレース\n\`\`\`\n${error.stack}\n\`\`\`` : ''}

## コンテキスト
${contextStr || '(なし)'}
${previousAttempts}

## 指示
1. エラーの原因を特定してください
2. 修正が必要なファイルを見つけてください
3. 適切な修正を行ってください
4. 修正後、エラーが解消されたことを確認してください

注意: 過去の試行が失敗している場合は、異なるアプローチを検討してください。`;
}

/**
 * RepairQueue クラス
 * 修正タスクの優先度管理と重複チェックを行う
 */
export class RepairQueue {
  private state: RepairQueueState;
  private initialized = false;

  constructor() {
    this.state = {
      tasks: [],
    };
  }

  private ensureWorkspaceDir(): void {
    if (!existsSync(WORKSPACE_DIR)) {
      mkdirSync(WORKSPACE_DIR, { recursive: true });
    }
  }

  /**
   * 永続化された状態を読み込む
   */
  initialize(): void {
    if (this.initialized) return;

    this.ensureWorkspaceDir();

    if (existsSync(QUEUE_FILE)) {
      try {
        const content = readFileSync(QUEUE_FILE, 'utf-8');
        this.state = JSON.parse(content) as RepairQueueState;
      } catch {
        this.state = { tasks: [] };
      }
    }

    this.initialized = true;
  }

  /**
   * 状態を永続化
   */
  private persist(): void {
    try {
      this.ensureWorkspaceDir();
      writeFileSync(QUEUE_FILE, JSON.stringify(this.state, null, 2), 'utf-8');
    } catch (e) {
      console.error('Failed to persist repair queue:', e);
    }
  }

  /**
   * 履歴に追記
   */
  private appendHistory(task: RepairTask): void {
    try {
      this.ensureWorkspaceDir();
      appendFileSync(HISTORY_FILE, JSON.stringify(task) + '\n', 'utf-8');
    } catch (e) {
      console.error('Failed to append to repair history:', e);
    }
  }

  /**
   * エラーに対する修正タスクを追加
   */
  enqueue(error: AggregatedError, priority?: RepairPriority, customPrompt?: string): RepairTask | null {
    this.initialize();

    const circuitBreaker = getRepairCircuitBreaker();

    // サーキットブレーカーをチェック
    if (!circuitBreaker.canAttemptRepair(error.source)) {
      console.warn(`Circuit breaker blocking repair for source: ${error.source}`);
      return null;
    }

    // 最大試行回数をチェック
    if (!circuitBreaker.canAttemptRepairForError(error.id, error.repairAttempts.length)) {
      console.warn(`Max repair attempts reached for error: ${error.id}`);
      return null;
    }

    // 重複チェック（同じエラーIDのタスクが既にキューにあるか）
    const existingTask = this.state.tasks.find(t => t.errorId === error.id && t.status === 'pending');
    if (existingTask) {
      return existingTask;
    }

    const task: RepairTask = {
      id: randomUUID(),
      errorId: error.id,
      priority: priority || severityToPriority(error.severity),
      prompt: customPrompt || generateRepairPrompt(error),
      maxAttempts: circuitBreaker.getConfig().maxAttemptsPerError,
      currentAttempt: error.repairAttempts.length + 1,
      createdAt: new Date().toISOString(),
      status: 'pending',
    };

    this.state.tasks.push(task);
    this.sortByPriority();
    this.persist();

    // エラーの状態をqueuedに更新
    getErrorAggregator().updateErrorStatus(error.id, 'queued');

    return task;
  }

  /**
   * 優先度でソート
   */
  private sortByPriority(): void {
    this.state.tasks.sort((a, b) => {
      // ステータス優先（pendingが先）
      if (a.status === 'pending' && b.status !== 'pending') return -1;
      if (a.status !== 'pending' && b.status === 'pending') return 1;

      // 優先度でソート
      const priorityDiff = priorityToNumber(b.priority) - priorityToNumber(a.priority);
      if (priorityDiff !== 0) return priorityDiff;

      // 作成日時でソート（古い順）
      return a.createdAt.localeCompare(b.createdAt);
    });
  }

  /**
   * 次の修正タスクを取得
   */
  dequeue(): RepairTask | null {
    this.initialize();

    const task = this.state.tasks.find(t => t.status === 'pending');
    if (!task) return null;

    task.status = 'in_progress';
    task.startedAt = new Date().toISOString();
    this.state.processingTaskId = task.id;
    this.persist();

    // エラーの状態をrepairingに更新
    getErrorAggregator().updateErrorStatus(task.errorId, 'repairing');

    return task;
  }

  /**
   * タスクを完了としてマーク
   */
  complete(taskId: string, result: RepairAttemptResult): boolean {
    this.initialize();

    const task = this.state.tasks.find(t => t.id === taskId);
    if (!task) return false;

    task.status = result.success ? 'completed' : 'failed';
    task.completedAt = new Date().toISOString();
    task.result = result;

    if (this.state.processingTaskId === taskId) {
      this.state.processingTaskId = undefined;
    }
    this.state.lastProcessedAt = new Date().toISOString();

    this.persist();
    this.appendHistory(task);

    // エラーに修正試行を記録
    const aggregator = getErrorAggregator();
    aggregator.recordRepairAttempt(task.errorId, result);

    // サーキットブレーカーを更新
    const error = aggregator.getError(task.errorId);
    const circuitBreaker = getRepairCircuitBreaker();

    if (result.success) {
      circuitBreaker.recordSuccess(error?.source);
      aggregator.updateErrorStatus(task.errorId, 'resolved', 'auto');
    } else {
      circuitBreaker.recordFailure(error?.source);
      aggregator.updateErrorStatus(task.errorId, 'failed');
    }

    // 完了したタスクをキューから削除
    this.state.tasks = this.state.tasks.filter(t => t.id !== taskId);
    this.persist();

    return true;
  }

  /**
   * タスクをキャンセル
   */
  cancel(taskId: string): boolean {
    this.initialize();

    const task = this.state.tasks.find(t => t.id === taskId);
    if (!task) return false;

    task.status = 'cancelled';
    task.completedAt = new Date().toISOString();

    if (this.state.processingTaskId === taskId) {
      this.state.processingTaskId = undefined;
    }

    this.persist();
    this.appendHistory(task);

    // エラーの状態を戻す
    getErrorAggregator().updateErrorStatus(task.errorId, 'new');

    // キューから削除
    this.state.tasks = this.state.tasks.filter(t => t.id !== taskId);
    this.persist();

    return true;
  }

  /**
   * キュー内のタスクを取得
   */
  getTasks(): RepairTask[] {
    this.initialize();
    return [...this.state.tasks];
  }

  /**
   * 待機中のタスク数を取得
   */
  getPendingCount(): number {
    this.initialize();
    return this.state.tasks.filter(t => t.status === 'pending').length;
  }

  /**
   * 処理中のタスクを取得
   */
  getProcessingTask(): RepairTask | null {
    this.initialize();
    if (!this.state.processingTaskId) return null;
    return this.state.tasks.find(t => t.id === this.state.processingTaskId) || null;
  }

  /**
   * タスクを取得
   */
  getTask(taskId: string): RepairTask | null {
    this.initialize();
    return this.state.tasks.find(t => t.id === taskId) || null;
  }

  /**
   * キューをクリア
   */
  clear(): void {
    this.initialize();

    // キャンセルされたタスクを履歴に追加
    for (const task of this.state.tasks) {
      if (task.status === 'pending' || task.status === 'in_progress') {
        task.status = 'cancelled';
        task.completedAt = new Date().toISOString();
        this.appendHistory(task);
      }
    }

    this.state.tasks = [];
    this.state.processingTaskId = undefined;
    this.persist();
  }
}

// シングルトンインスタンス
let instance: RepairQueue | null = null;

export function getRepairQueue(): RepairQueue {
  if (!instance) {
    instance = new RepairQueue();
  }
  return instance;
}
