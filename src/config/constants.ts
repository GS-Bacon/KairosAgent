/**
 * Centralized Configuration Constants
 *
 * マジックナンバーを排除し、全設定値を一箇所に集約
 */

// ========================================
// Orchestration
// ========================================

export const ORCHESTRATION = {
  /** 連続失敗でシステム一時停止する閾値 */
  MAX_CONSECUTIVE_FAILURES: 5,
  /** キュークリーンアップの日数 */
  CLEANUP_DAYS: 30,
  /** 1サイクルあたりの最大確認レビュー件数 */
  MAX_CONFIRMATIONS_PER_CYCLE: 3,
} as const;

// ========================================
// Retry & Backoff
// ========================================

export const RETRY = {
  /** スケジューラのデフォルト最大リトライ回数 */
  MAX_RETRIES: 3,
  /** スケジューラの基本バックオフ (ms) */
  SCHEDULER_BASE_BACKOFF_MS: 5000,
  /** スケジューラの最大バックオフ (ms) — 10分 */
  SCHEDULER_MAX_BACKOFF_MS: 10 * 60 * 1000,
  /** スケジューラのクールダウン期間 (ms) — 10分 */
  SCHEDULER_COOLDOWN_MS: 10 * 60 * 1000,
  /** Implement phase の構文エラーリトライ上限 */
  SYNTAX_ERROR_MAX_RETRIES: 2,
} as const;

// ========================================
// Rate Limit & Circuit Breaker
// ========================================

export const RATE_LIMIT = {
  /** Resilient Providerの基本バックオフ (ms) — 5秒 */
  BASE_BACKOFF_MS: 5000,
  /** Resilient Providerの最大バックオフ (ms) — 5分 */
  MAX_BACKOFF_MS: 300000,
  /** Circuit Breaker を Open にする連続失敗回数 */
  CIRCUIT_BREAKER_THRESHOLD: 3,
  /** フォールバック変更の確認キューデフォルト優先度 */
  FALLBACK_CONFIRMATION_PRIORITY: 50,
} as const;

// ========================================
// Provider Health
// ========================================

export const PROVIDER_HEALTH = {
  /** Broken判定の連続失敗回数 */
  FAILURE_THRESHOLD: 3,
  /** Degraded判定の連続失敗回数 */
  DEGRADED_THRESHOLD: 1,
  /** リペアクールダウン (ms) — 5分 */
  REPAIR_COOLDOWN_MS: 300000,
  /** リカバリチェック間隔 (ms) — 5分 */
  RECOVERY_CHECK_INTERVAL_MS: 5 * 60 * 1000,
} as const;

// ========================================
// Hybrid Provider
// ========================================

export const HYBRID_PROVIDER = {
  /** 基本バックオフ (ms) — 1分 */
  BASE_BACKOFF_MS: 60000,
  /** 最大バックオフ (ms) — 10分 */
  MAX_BACKOFF_MS: 600000,
} as const;

// ========================================
// OpenCode Provider
// ========================================

export const OPENCODE = {
  /** 最大タイムアウト (ms) — 5分 */
  MAX_TIMEOUT_MS: 300000,
} as const;

// ========================================
// API & Pagination
// ========================================

export const API = {
  /** サーバーポート */
  PORT: 3100,
  /** インメモリ履歴の最大件数 */
  MAX_HISTORY_ENTRIES: 1000,
  /** ステータス統計の日数範囲 */
  STATS_DAYS: 30,
  /** コンテキスト文字列の最大表示長 */
  CONTEXT_TRUNCATION_LENGTH: 200,
} as const;

export const PAGINATION = {
  /** ログページ: デフォルト件数 */
  LOGS_DEFAULT: 100,
  /** ログページ: 最大件数 */
  LOGS_MAX: 500,
  /** 履歴ページ: デフォルト件数 */
  HISTORY_DEFAULT: 50,
  /** 履歴ページ: 最大件数 */
  HISTORY_MAX: 200,
  /** スナップショット/ロールバック: デフォルト件数 */
  SNAPSHOTS_DEFAULT: 50,
  /** スナップショット/ロールバック: 最大件数 */
  SNAPSHOTS_MAX: 200,
  /** イベント履歴: デフォルト件数 */
  EVENTS_DEFAULT: 100,
  /** イベント履歴: 最大件数 */
  EVENTS_MAX: 500,
  /** サイクル一覧: デフォルト件数 */
  CYCLES_DEFAULT: 50,
  /** サイクル一覧: 最大件数 */
  CYCLES_MAX: 200,
  /** GLM変更一覧: 最大件数 */
  GLM_CHANGES_MAX: 100,
} as const;

// ========================================
// Storage & Rotation
// ========================================

export const STORAGE = {
  /** トラブルの最大アクティブ件数 */
  MAX_ACTIVE_TROUBLES: 500,
  /** 改善キューのデフォルト優先度 */
  DEFAULT_IMPROVEMENT_PRIORITY: 50,
  /** パターン履歴の最大エントリ数 */
  PATTERN_HISTORY_MAX: 50,
} as const;

// ========================================
// Token & Code Generation
// ========================================

export const CODE_GENERATION = {
  /** 大きいコードと判定する文字数閾値 */
  LARGE_CODE_THRESHOLD: 32_000,
  /** エラー周辺のコンテキスト行数 */
  CONTEXT_LINES: 50,
  /** リトライ時フィードバックのコード上限文字数 */
  RETRY_FEEDBACK_CODE_LIMIT: 8000,
  /** 自動修復する閉じ括弧の最大数 */
  MAX_AUTO_REPAIR_BRACKETS: 5,
} as const;

// ========================================
// Server & Scheduling
// ========================================

export const SCHEDULING = {
  /** デフォルトのサイクル間隔 (ms) — 1時間 */
  DEFAULT_CYCLE_INTERVAL_MS: 3600000,
  /** ヘルスチェック間隔 (ms) — 5分 */
  HEALTH_CHECK_INTERVAL_MS: 5 * 60 * 1000,
} as const;
