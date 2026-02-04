export interface RateLimitState {
    isActive: boolean;
    detectedAt: Date | null;
    cooldownUntil: Date | null;
    consecutiveHits: number;
    source: string | null;
}
export declare class RateLimitManager {
    private state;
    private onRateLimitCallback?;
    constructor();
    /**
     * レートリミット検出時に呼び出し
     */
    recordRateLimitHit(source: string): Promise<void>;
    /**
     * 現在レートリミット中かチェック
     */
    isRateLimited(): boolean;
    /**
     * 残り冷却時間（ミリ秒）
     */
    getRemainingCooldownMs(): number;
    /**
     * 現在の状態を取得
     */
    getState(): RateLimitState;
    /**
     * 手動リセット
     */
    reset(): Promise<void>;
    /**
     * 通知コールバックを設定
     */
    setNotificationCallback(callback: (isActive: boolean, details: string) => Promise<void>): void;
    /**
     * 冷却期間終了時にレートリミットを解除
     */
    private clearRateLimit;
    /**
     * 状態を永続化
     */
    private saveState;
    /**
     * 状態を読み込み
     */
    private loadState;
}
export declare function getRateLimitManager(): RateLimitManager;
//# sourceMappingURL=rate-limit-manager.d.ts.map