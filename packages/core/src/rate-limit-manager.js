import { existsSync, readFileSync, writeFileSync, mkdirSync } from 'fs';
import { join } from 'path';
import { getLogger } from './logger.js';
const logger = getLogger('core:rate-limit-manager');
const WORKSPACE_DIR = join(process.cwd(), 'workspace');
const STATE_PATH = join(WORKSPACE_DIR, 'rate-limit-state.json');
// 冷却期間設定（ミリ秒）
const INITIAL_COOLDOWN_MS = 5 * 60 * 1000; // 5分
const MAX_COOLDOWN_MS = 30 * 60 * 1000; // 30分
export class RateLimitManager {
    state = {
        isActive: false,
        detectedAt: null,
        cooldownUntil: null,
        consecutiveHits: 0,
        source: null,
    };
    onRateLimitCallback;
    constructor() {
        this.loadState();
        logger.info('RateLimitManager initialized', {
            isActive: this.state.isActive,
            consecutiveHits: this.state.consecutiveHits,
        });
    }
    /**
     * レートリミット検出時に呼び出し
     */
    async recordRateLimitHit(source) {
        const now = new Date();
        this.state.consecutiveHits++;
        // 冷却期間を計算（指数バックオフ、最大30分）
        const cooldownMs = Math.min(INITIAL_COOLDOWN_MS * Math.pow(2, this.state.consecutiveHits - 1), MAX_COOLDOWN_MS);
        this.state.isActive = true;
        this.state.detectedAt = now;
        this.state.cooldownUntil = new Date(now.getTime() + cooldownMs);
        this.state.source = source;
        this.saveState();
        logger.warn('Rate limit detected', {
            source,
            consecutiveHits: this.state.consecutiveHits,
            cooldownMs,
            cooldownUntil: this.state.cooldownUntil.toISOString(),
        });
        // コールバックを呼び出し（Discord通知など）
        if (this.onRateLimitCallback) {
            const details = `ソース: ${source}, 連続検出: ${this.state.consecutiveHits}回, 冷却期間: ${Math.round(cooldownMs / 60000)}分`;
            await this.onRateLimitCallback(true, details);
        }
    }
    /**
     * 現在レートリミット中かチェック
     */
    isRateLimited() {
        if (!this.state.isActive) {
            return false;
        }
        // 冷却期間が終了したかチェック
        if (this.state.cooldownUntil && new Date() >= this.state.cooldownUntil) {
            this.clearRateLimit();
            return false;
        }
        return true;
    }
    /**
     * 残り冷却時間（ミリ秒）
     */
    getRemainingCooldownMs() {
        if (!this.state.isActive || !this.state.cooldownUntil) {
            return 0;
        }
        const remaining = this.state.cooldownUntil.getTime() - Date.now();
        return Math.max(0, remaining);
    }
    /**
     * 現在の状態を取得
     */
    getState() {
        // コピーを返す
        return {
            ...this.state,
            detectedAt: this.state.detectedAt ? new Date(this.state.detectedAt) : null,
            cooldownUntil: this.state.cooldownUntil ? new Date(this.state.cooldownUntil) : null,
        };
    }
    /**
     * 手動リセット
     */
    async reset() {
        const wasActive = this.state.isActive;
        this.state = {
            isActive: false,
            detectedAt: null,
            cooldownUntil: null,
            consecutiveHits: 0,
            source: null,
        };
        this.saveState();
        logger.info('Rate limit state reset');
        if (wasActive && this.onRateLimitCallback) {
            await this.onRateLimitCallback(false, 'レートリミット状態が手動でリセットされました');
        }
    }
    /**
     * 通知コールバックを設定
     */
    setNotificationCallback(callback) {
        this.onRateLimitCallback = callback;
    }
    /**
     * 冷却期間終了時にレートリミットを解除
     */
    async clearRateLimit() {
        logger.info('Rate limit cooldown expired, clearing state', {
            consecutiveHits: this.state.consecutiveHits,
        });
        const wasConsecutiveHits = this.state.consecutiveHits;
        this.state.isActive = false;
        this.state.detectedAt = null;
        this.state.cooldownUntil = null;
        // consecutiveHitsは維持（次回ヒット時に増加し続ける）
        this.saveState();
        if (this.onRateLimitCallback) {
            await this.onRateLimitCallback(false, `冷却期間が終了しました。累計連続ヒット: ${wasConsecutiveHits}回`);
        }
    }
    /**
     * 状態を永続化
     */
    saveState() {
        try {
            if (!existsSync(WORKSPACE_DIR)) {
                mkdirSync(WORKSPACE_DIR, { recursive: true });
            }
            const persisted = {
                isActive: this.state.isActive,
                detectedAt: this.state.detectedAt?.toISOString() ?? null,
                cooldownUntil: this.state.cooldownUntil?.toISOString() ?? null,
                consecutiveHits: this.state.consecutiveHits,
                source: this.state.source,
            };
            writeFileSync(STATE_PATH, JSON.stringify(persisted, null, 2));
        }
        catch (error) {
            logger.error('Failed to save rate limit state', { error });
        }
    }
    /**
     * 状態を読み込み
     */
    loadState() {
        try {
            if (existsSync(STATE_PATH)) {
                const content = readFileSync(STATE_PATH, 'utf-8');
                const persisted = JSON.parse(content);
                this.state = {
                    isActive: persisted.isActive,
                    detectedAt: persisted.detectedAt ? new Date(persisted.detectedAt) : null,
                    cooldownUntil: persisted.cooldownUntil ? new Date(persisted.cooldownUntil) : null,
                    consecutiveHits: persisted.consecutiveHits,
                    source: persisted.source,
                };
                // 冷却期間が過ぎていたらリセット
                if (this.state.isActive && this.state.cooldownUntil && new Date() >= this.state.cooldownUntil) {
                    this.state.isActive = false;
                    this.state.detectedAt = null;
                    this.state.cooldownUntil = null;
                    logger.info('Rate limit state cleared on load (cooldown expired)');
                }
            }
        }
        catch (error) {
            logger.warn('Failed to load rate limit state', { error });
        }
    }
}
let instance = null;
export function getRateLimitManager() {
    if (!instance) {
        instance = new RateLimitManager();
    }
    return instance;
}
//# sourceMappingURL=rate-limit-manager.js.map