/**
 * エラー集約・自動修正システムの型定義
 */

/**
 * エラーの発生元
 */
export type ErrorSource =
  | 'orchestrator'
  | 'strategy_execution'
  | 'suggestion_implementation'
  | 'scheduler'
  | 'notification'
  | 'dashboard'
  | 'unknown';

/**
 * エラーカテゴリ
 */
export type ErrorCategory =
  | 'transient'      // 一時的なエラー（ネットワーク等）
  | 'permanent'      // 永続的なエラー（設定ミス等）
  | 'resource'       // リソース不足
  | 'external'       // 外部サービスエラー
  | 'configuration'  // 設定エラー
  | 'validation'     // バリデーションエラー
  | 'timeout'        // タイムアウト
  | 'unknown';

/**
 * エラーの重要度
 */
export type ErrorSeverity = 'low' | 'medium' | 'high' | 'critical';

/**
 * エラーの修正状態
 */
export type ErrorStatus =
  | 'new'        // 新規
  | 'queued'     // 修正キュー待ち
  | 'repairing'  // 修正中
  | 'resolved'   // 解決済み
  | 'failed'     // 修正失敗
  | 'ignored';   // 無視

/**
 * 修正試行の結果
 */
export interface RepairAttemptResult {
  timestamp: string;
  success: boolean;
  prompt: string;
  output?: string;
  error?: string;
  durationMs: number;
}

/**
 * 集約されたエラー
 */
export interface AggregatedError {
  id: string;
  timestamp: string;
  source: ErrorSource;
  category: ErrorCategory;
  severity: ErrorSeverity;
  status: ErrorStatus;
  message: string;
  stack?: string;
  context: Record<string, unknown>;
  repairAttempts: RepairAttemptResult[];
  resolvedAt?: string;
  resolvedBy?: 'auto' | 'manual';
}

/**
 * エラー報告の入力
 */
export interface ErrorReport {
  source: ErrorSource;
  error: Error | string;
  context?: Record<string, unknown>;
  severity?: ErrorSeverity;
  category?: ErrorCategory;
}

/**
 * 修正タスクの優先度
 */
export type RepairPriority = 'low' | 'normal' | 'high' | 'urgent';

/**
 * 修正タスク
 */
export interface RepairTask {
  id: string;
  errorId: string;
  priority: RepairPriority;
  prompt: string;
  maxAttempts: number;
  currentAttempt: number;
  createdAt: string;
  startedAt?: string;
  completedAt?: string;
  status: 'pending' | 'in_progress' | 'completed' | 'failed' | 'cancelled';
  result?: RepairAttemptResult;
}

/**
 * サーキットブレーカーの状態
 */
export type CircuitBreakerState = 'closed' | 'open' | 'half_open';

/**
 * サーキットブレーカーの設定
 */
export interface CircuitBreakerConfig {
  maxAttemptsPerError: number;      // エラーごとの最大修正試行回数
  maxConsecutiveFailuresPerSource: number;  // ソースごとの連続失敗上限
  maxConsecutiveFailuresGlobal: number;     // 全体の連続失敗上限
  cooldownMs: number;               // クールダウン期間（ミリ秒）
  halfOpenTestCount: number;        // half-open状態でのテスト回数
}

/**
 * サーキットブレーカーの永続化状態
 */
export interface CircuitBreakerPersistentState {
  state: CircuitBreakerState;
  lastFailureAt?: string;
  consecutiveFailuresGlobal: number;
  consecutiveFailuresPerSource: Record<ErrorSource, number>;
  openedAt?: string;
  halfOpenTestsRemaining?: number;
}

/**
 * 修正キューの状態
 */
export interface RepairQueueState {
  tasks: RepairTask[];
  lastProcessedAt?: string;
  processingTaskId?: string;
}

/**
 * エラー集約の統計
 */
export interface ErrorAggregatorStats {
  totalErrors: number;
  errorsByStatus: Record<ErrorStatus, number>;
  errorsBySource: Record<ErrorSource, number>;
  errorsBySeverity: Record<ErrorSeverity, number>;
  repairAttempts: number;
  successfulRepairs: number;
  failedRepairs: number;
}

/**
 * 自動修正の設定
 */
export interface AutoRepairConfig {
  enabled: boolean;
  maxConcurrentRepairs: number;
  defaultMaxAttempts: number;
  claudeCliPath: string;
  workingDirectory: string;
  timeoutMs: number;
}

/**
 * エラーフィルター条件
 */
export interface ErrorFilter {
  sources?: ErrorSource[];
  categories?: ErrorCategory[];
  severities?: ErrorSeverity[];
  statuses?: ErrorStatus[];
  since?: string;
  until?: string;
  limit?: number;
  offset?: number;
}
