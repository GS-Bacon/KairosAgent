/**
 * サーキットブレーカー
 * 無限ループ防止のための保護機構
 */

import { existsSync, readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import type {
  CircuitBreakerConfig,
  CircuitBreakerPersistentState,
  CircuitBreakerState,
  ErrorSource,
} from './types.js';

const WORKSPACE_DIR = process.env.ERROR_AGGREGATOR_WORKSPACE ||
  join(process.cwd(), 'workspace', 'errors');

const STATE_FILE = join(WORKSPACE_DIR, 'circuit-breaker-state.json');

const DEFAULT_CONFIG: CircuitBreakerConfig = {
  maxAttemptsPerError: 3,
  maxConsecutiveFailuresPerSource: 5,
  maxConsecutiveFailuresGlobal: 10,
  cooldownMs: 60 * 60 * 1000, // 1時間
  halfOpenTestCount: 2,
};

/**
 * RepairCircuitBreaker クラス
 * 修正処理の無限ループを防止する
 */
export class RepairCircuitBreaker {
  private config: CircuitBreakerConfig;
  private state: CircuitBreakerPersistentState;
  private initialized = false;

  constructor(config: Partial<CircuitBreakerConfig> = {}) {
    this.config = { ...DEFAULT_CONFIG, ...config };
    this.state = this.getDefaultState();
  }

  private getDefaultState(): CircuitBreakerPersistentState {
    return {
      state: 'closed',
      consecutiveFailuresGlobal: 0,
      consecutiveFailuresPerSource: {
        orchestrator: 0,
        strategy_execution: 0,
        suggestion_implementation: 0,
        scheduler: 0,
        notification: 0,
        dashboard: 0,
        unknown: 0,
      },
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

    if (existsSync(STATE_FILE)) {
      try {
        const content = readFileSync(STATE_FILE, 'utf-8');
        const loaded = JSON.parse(content) as CircuitBreakerPersistentState;
        this.state = {
          ...this.getDefaultState(),
          ...loaded,
        };
      } catch {
        this.state = this.getDefaultState();
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
      writeFileSync(STATE_FILE, JSON.stringify(this.state, null, 2), 'utf-8');
    } catch (e) {
      console.error('Failed to persist circuit breaker state:', e);
    }
  }

  /**
   * 修正を実行できるかどうかをチェック
   */
  canAttemptRepair(source?: ErrorSource): boolean {
    this.initialize();

    // クールダウン期間をチェック
    if (this.state.state === 'open' && this.state.openedAt) {
      const openedAt = new Date(this.state.openedAt).getTime();
      const elapsed = Date.now() - openedAt;

      if (elapsed >= this.config.cooldownMs) {
        // クールダウン終了、half-openに移行
        this.state.state = 'half_open';
        this.state.halfOpenTestsRemaining = this.config.halfOpenTestCount;
        this.persist();
      } else {
        // まだクールダウン中
        return false;
      }
    }

    // open状態なら拒否
    if (this.state.state === 'open') {
      return false;
    }

    // ソース別の連続失敗をチェック
    if (source && this.state.consecutiveFailuresPerSource[source] >= this.config.maxConsecutiveFailuresPerSource) {
      return false;
    }

    return true;
  }

  /**
   * 特定のエラーに対して修正を試行できるかチェック
   */
  canAttemptRepairForError(errorId: string, currentAttempts: number): boolean {
    return currentAttempts < this.config.maxAttemptsPerError && this.canAttemptRepair();
  }

  /**
   * 修正成功を記録
   */
  recordSuccess(source?: ErrorSource): void {
    this.initialize();

    // 連続失敗をリセット
    this.state.consecutiveFailuresGlobal = 0;
    if (source) {
      this.state.consecutiveFailuresPerSource[source] = 0;
    }

    // half-openからclosedへ
    if (this.state.state === 'half_open') {
      if (this.state.halfOpenTestsRemaining !== undefined) {
        this.state.halfOpenTestsRemaining--;
        if (this.state.halfOpenTestsRemaining <= 0) {
          this.state.state = 'closed';
          delete this.state.halfOpenTestsRemaining;
          delete this.state.openedAt;
        }
      } else {
        this.state.state = 'closed';
      }
    }

    this.persist();
  }

  /**
   * 修正失敗を記録
   */
  recordFailure(source?: ErrorSource): void {
    this.initialize();

    this.state.consecutiveFailuresGlobal++;
    this.state.lastFailureAt = new Date().toISOString();

    if (source) {
      this.state.consecutiveFailuresPerSource[source]++;
    }

    // 連続失敗がしきい値を超えたらopen
    if (this.state.consecutiveFailuresGlobal >= this.config.maxConsecutiveFailuresGlobal) {
      this.tripBreaker('global consecutive failures exceeded');
    } else if (source && this.state.consecutiveFailuresPerSource[source] >= this.config.maxConsecutiveFailuresPerSource) {
      // ソース別ではトリップしない（そのソースだけ制限）
    }

    // half-open中の失敗はすぐにopen
    if (this.state.state === 'half_open') {
      this.tripBreaker('failure during half-open');
    }

    this.persist();
  }

  /**
   * ブレーカーをトリップ（open状態に）
   */
  private tripBreaker(reason: string): void {
    console.warn(`Circuit breaker tripped: ${reason}`);
    this.state.state = 'open';
    this.state.openedAt = new Date().toISOString();
    delete this.state.halfOpenTestsRemaining;
  }

  /**
   * ブレーカーを手動でリセット
   */
  reset(): void {
    this.initialize();
    this.state = this.getDefaultState();
    this.persist();
  }

  /**
   * 特定のソースの失敗カウンターをリセット
   */
  resetSource(source: ErrorSource): void {
    this.initialize();
    this.state.consecutiveFailuresPerSource[source] = 0;
    this.persist();
  }

  /**
   * 現在の状態を取得
   */
  getState(): CircuitBreakerPersistentState {
    this.initialize();
    return { ...this.state };
  }

  /**
   * 設定を取得
   */
  getConfig(): CircuitBreakerConfig {
    return { ...this.config };
  }

  /**
   * クールダウン終了までの残り時間を取得（ミリ秒）
   */
  getRemainingCooldownMs(): number {
    this.initialize();

    if (this.state.state !== 'open' || !this.state.openedAt) {
      return 0;
    }

    const openedAt = new Date(this.state.openedAt).getTime();
    const elapsed = Date.now() - openedAt;
    return Math.max(0, this.config.cooldownMs - elapsed);
  }
}

// シングルトンインスタンス
let instance: RepairCircuitBreaker | null = null;

export function getRepairCircuitBreaker(): RepairCircuitBreaker {
  if (!instance) {
    instance = new RepairCircuitBreaker();
  }
  return instance;
}
