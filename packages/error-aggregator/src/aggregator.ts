/**
 * エラー集約コア
 * 様々なコンポーネントから発生するエラーを1箇所に集約する
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync, appendFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { randomUUID } from 'node:crypto';
import type {
  AggregatedError,
  ErrorReport,
  ErrorSource,
  ErrorCategory,
  ErrorSeverity,
  ErrorStatus,
  ErrorFilter,
  ErrorAggregatorStats,
} from './types.js';

const WORKSPACE_DIR = process.env.ERROR_AGGREGATOR_WORKSPACE ||
  join(process.cwd(), 'workspace', 'errors');

const ERRORS_FILE = join(WORKSPACE_DIR, 'aggregated-errors.jsonl');

/**
 * エラーを分類する
 */
function classifyError(error: Error | string): { category: ErrorCategory; severity: ErrorSeverity } {
  const message = typeof error === 'string' ? error : error.message;
  const lowerMessage = message.toLowerCase();

  // タイムアウト
  if (lowerMessage.includes('timeout') || lowerMessage.includes('timed out')) {
    return { category: 'timeout', severity: 'medium' };
  }

  // ネットワーク/一時的エラー
  if (
    lowerMessage.includes('network') ||
    lowerMessage.includes('econnrefused') ||
    lowerMessage.includes('econnreset') ||
    lowerMessage.includes('socket hang up') ||
    lowerMessage.includes('rate limit') ||
    lowerMessage.includes('429')
  ) {
    return { category: 'transient', severity: 'low' };
  }

  // 外部サービスエラー
  if (
    lowerMessage.includes('api error') ||
    lowerMessage.includes('discord') ||
    lowerMessage.includes('claude') ||
    lowerMessage.includes('external service')
  ) {
    return { category: 'external', severity: 'medium' };
  }

  // 設定エラー
  if (
    lowerMessage.includes('config') ||
    lowerMessage.includes('environment') ||
    lowerMessage.includes('missing') ||
    lowerMessage.includes('not found') && lowerMessage.includes('file')
  ) {
    return { category: 'configuration', severity: 'high' };
  }

  // バリデーションエラー
  if (
    lowerMessage.includes('invalid') ||
    lowerMessage.includes('validation') ||
    lowerMessage.includes('expected')
  ) {
    return { category: 'validation', severity: 'medium' };
  }

  // リソースエラー
  if (
    lowerMessage.includes('memory') ||
    lowerMessage.includes('disk') ||
    lowerMessage.includes('resource') ||
    lowerMessage.includes('quota')
  ) {
    return { category: 'resource', severity: 'high' };
  }

  // code 143 (SIGTERM) - プロセス終了
  if (lowerMessage.includes('code 143') || lowerMessage.includes('sigterm')) {
    return { category: 'timeout', severity: 'medium' };
  }

  return { category: 'unknown', severity: 'medium' };
}

/**
 * ErrorAggregator クラス
 * エラーを統一インターフェースで受け取り、集約・永続化する
 */
export class ErrorAggregator {
  private errors: Map<string, AggregatedError> = new Map();
  private initialized = false;

  constructor() {
    this.ensureWorkspaceDir();
  }

  private ensureWorkspaceDir(): void {
    if (!existsSync(WORKSPACE_DIR)) {
      mkdirSync(WORKSPACE_DIR, { recursive: true });
    }
  }

  /**
   * 永続化されたエラーを読み込む
   */
  initialize(): void {
    if (this.initialized) return;

    this.ensureWorkspaceDir();

    if (existsSync(ERRORS_FILE)) {
      try {
        const content = readFileSync(ERRORS_FILE, 'utf-8');
        const lines = content.trim().split('\n').filter(line => line.length > 0);

        for (const line of lines) {
          try {
            const error = JSON.parse(line) as AggregatedError;
            this.errors.set(error.id, error);
          } catch {
            // 不正な行は無視
          }
        }
      } catch {
        // ファイル読み込みエラーは無視
      }
    }

    this.initialized = true;
  }

  /**
   * エラーを報告する
   */
  reportError(report: ErrorReport): AggregatedError {
    this.initialize();

    const { source, error, context = {}, severity, category } = report;
    const errorMessage = typeof error === 'string' ? error : error.message;
    const errorStack = typeof error === 'string' ? undefined : error.stack;

    // 自動分類
    const classified = classifyError(error);

    const aggregatedError: AggregatedError = {
      id: randomUUID(),
      timestamp: new Date().toISOString(),
      source,
      category: category || classified.category,
      severity: severity || classified.severity,
      status: 'new',
      message: errorMessage,
      stack: errorStack,
      context,
      repairAttempts: [],
    };

    // メモリに保存
    this.errors.set(aggregatedError.id, aggregatedError);

    // ファイルに追記
    this.appendError(aggregatedError);

    return aggregatedError;
  }

  /**
   * 便利なエラー報告メソッド
   */
  report(source: ErrorSource, error: Error | string, context?: Record<string, unknown>): AggregatedError {
    return this.reportError({ source, error, context });
  }

  /**
   * エラーをファイルに追記
   */
  private appendError(error: AggregatedError): void {
    try {
      this.ensureWorkspaceDir();
      appendFileSync(ERRORS_FILE, JSON.stringify(error) + '\n', 'utf-8');
    } catch (e) {
      console.error('Failed to append error to file:', e);
    }
  }

  /**
   * エラーの状態を更新
   */
  updateErrorStatus(errorId: string, status: ErrorStatus, resolvedBy?: 'auto' | 'manual'): boolean {
    this.initialize();

    const error = this.errors.get(errorId);
    if (!error) return false;

    error.status = status;
    if (status === 'resolved') {
      error.resolvedAt = new Date().toISOString();
      error.resolvedBy = resolvedBy;
    }

    // ファイル全体を書き換え
    this.persistAllErrors();

    return true;
  }

  /**
   * 修正試行を記録
   */
  recordRepairAttempt(errorId: string, attempt: AggregatedError['repairAttempts'][0]): boolean {
    this.initialize();

    const error = this.errors.get(errorId);
    if (!error) return false;

    error.repairAttempts.push(attempt);
    this.persistAllErrors();

    return true;
  }

  /**
   * エラーを取得
   */
  getError(errorId: string): AggregatedError | undefined {
    this.initialize();
    return this.errors.get(errorId);
  }

  /**
   * エラーをフィルタリングして取得
   */
  getErrors(filter: ErrorFilter = {}): AggregatedError[] {
    this.initialize();

    let errors = Array.from(this.errors.values());

    if (filter.sources?.length) {
      errors = errors.filter(e => filter.sources!.includes(e.source));
    }
    if (filter.categories?.length) {
      errors = errors.filter(e => filter.categories!.includes(e.category));
    }
    if (filter.severities?.length) {
      errors = errors.filter(e => filter.severities!.includes(e.severity));
    }
    if (filter.statuses?.length) {
      errors = errors.filter(e => filter.statuses!.includes(e.status));
    }
    if (filter.since) {
      errors = errors.filter(e => e.timestamp >= filter.since!);
    }
    if (filter.until) {
      errors = errors.filter(e => e.timestamp <= filter.until!);
    }

    // 新しい順にソート
    errors.sort((a, b) => b.timestamp.localeCompare(a.timestamp));

    if (filter.offset) {
      errors = errors.slice(filter.offset);
    }
    if (filter.limit) {
      errors = errors.slice(0, filter.limit);
    }

    return errors;
  }

  /**
   * 新規/未解決のエラーを取得
   */
  getPendingErrors(): AggregatedError[] {
    return this.getErrors({
      statuses: ['new', 'queued', 'repairing'],
    });
  }

  /**
   * 統計を取得
   */
  getStats(): ErrorAggregatorStats {
    this.initialize();

    const errors = Array.from(this.errors.values());

    const stats: ErrorAggregatorStats = {
      totalErrors: errors.length,
      errorsByStatus: {
        new: 0,
        queued: 0,
        repairing: 0,
        resolved: 0,
        failed: 0,
        ignored: 0,
      },
      errorsBySource: {
        orchestrator: 0,
        strategy_execution: 0,
        suggestion_implementation: 0,
        scheduler: 0,
        notification: 0,
        dashboard: 0,
        unknown: 0,
      },
      errorsBySeverity: {
        low: 0,
        medium: 0,
        high: 0,
        critical: 0,
      },
      repairAttempts: 0,
      successfulRepairs: 0,
      failedRepairs: 0,
    };

    for (const error of errors) {
      stats.errorsByStatus[error.status]++;
      stats.errorsBySource[error.source]++;
      stats.errorsBySeverity[error.severity]++;
      stats.repairAttempts += error.repairAttempts.length;

      const successfulAttempts = error.repairAttempts.filter(a => a.success);
      if (successfulAttempts.length > 0) {
        stats.successfulRepairs++;
      } else if (error.repairAttempts.length > 0 && error.status === 'failed') {
        stats.failedRepairs++;
      }
    }

    return stats;
  }

  /**
   * 全エラーを永続化
   */
  private persistAllErrors(): void {
    try {
      this.ensureWorkspaceDir();
      const content = Array.from(this.errors.values())
        .map(e => JSON.stringify(e))
        .join('\n');
      writeFileSync(ERRORS_FILE, content + '\n', 'utf-8');
    } catch (e) {
      console.error('Failed to persist errors:', e);
    }
  }

  /**
   * 古いエラーをクリーンアップ
   */
  cleanup(olderThanDays: number = 30): number {
    this.initialize();

    const cutoff = new Date();
    cutoff.setDate(cutoff.getDate() - olderThanDays);
    const cutoffStr = cutoff.toISOString();

    let removed = 0;
    for (const [id, error] of this.errors) {
      if (error.timestamp < cutoffStr && (error.status === 'resolved' || error.status === 'ignored')) {
        this.errors.delete(id);
        removed++;
      }
    }

    if (removed > 0) {
      this.persistAllErrors();
    }

    return removed;
  }
}

// シングルトンインスタンス
let instance: ErrorAggregator | null = null;

export function getErrorAggregator(): ErrorAggregator {
  if (!instance) {
    instance = new ErrorAggregator();
  }
  return instance;
}
