import { getLogger } from '@auto-claude/core';
import { existsSync, readFileSync, writeFileSync, mkdirSync } from 'fs';
import { join } from 'path';
const logger = getLogger('notification:discord');
// 設定ファイルのパス
const WORKSPACE_DIR = join(process.cwd(), 'workspace');
const SETTINGS_PATH = join(WORKSPACE_DIR, 'notification-settings.json');
const HISTORY_PATH = join(WORKSPACE_DIR, 'notification-history.json');
// すべての通知項目の定義
export const NOTIFICATION_ITEMS = [
    // システム関連
    { id: 'system_startup', name: 'システム起動', description: 'AutoClaudeKMP が起動したとき', category: 'success', defaultEnabled: true },
    { id: 'system_shutdown', name: 'システム停止', description: 'AutoClaudeKMP が停止したとき', category: 'info', defaultEnabled: true },
    { id: 'heartbeat', name: 'ハートビート', description: '定期的なステータス更新', category: 'info', defaultEnabled: false },
    { id: 'heartbeat_failure', name: 'ハートビート障害', description: 'ハートビートが連続失敗したとき', category: 'critical', defaultEnabled: true },
    { id: 'uncaught_exception', name: '未捕捉例外', description: '処理されなかった例外が発生したとき', category: 'critical', defaultEnabled: true },
    { id: 'rate_limit', name: 'レートリミット', description: 'API レートリミットの検出・解除', category: 'warning', defaultEnabled: true },
    // レポート関連
    { id: 'daily_report', name: '日次レポート', description: '日次の収支・活動サマリー', category: 'info', defaultEnabled: true },
    { id: 'weekly_report', name: '週報', description: '週次の詳細レポート', category: 'info', defaultEnabled: true },
    { id: 'weekly_retrospective', name: '週次振り返り', description: '週次振り返り分析の結果', category: 'info', defaultEnabled: true },
    // 提案関連
    { id: 'suggestion_response', name: '提案への回答', description: 'ユーザー提案に対するシステムの回答', category: 'suggestionResponse', defaultEnabled: true },
    { id: 'suggestion_auto_reject', name: '保留提案の自動却下', description: '期限切れ提案の自動却下', category: 'info', defaultEnabled: false },
    { id: 'suggestion_re_evaluate', name: '保留提案の再評価', description: '保留提案の再評価結果', category: 'info', defaultEnabled: false },
    { id: 'suggestion_auto_implement', name: '提案の自動実装', description: '承認された提案の自動実装完了', category: 'success', defaultEnabled: true },
    { id: 'suggestion_implement_failed', name: '提案実装失敗', description: '提案の実装が失敗したとき', category: 'warning', defaultEnabled: true },
    // 戦略関連
    { id: 'strategy_execution_complete', name: '戦略実行完了', description: '戦略が正常に完了したとき', category: 'success', defaultEnabled: true },
    { id: 'strategy_execution_failed', name: '戦略実行失敗', description: '戦略の実行が失敗したとき', category: 'warning', defaultEnabled: true },
    { id: 'strategy_cycle_complete', name: '戦略サイクル完了', description: '複数戦略の実行サイクル完了', category: 'info', defaultEnabled: false },
    { id: 'strategy_auto_stop', name: '戦略自動停止', description: 'エラーにより戦略が自動停止したとき', category: 'critical', defaultEnabled: true },
    { id: 'strategy_limit', name: '戦略制限', description: '同時実行戦略数の上限到達', category: 'warning', defaultEnabled: true },
    { id: 'strategy_activated', name: '戦略アクティブ化', description: '戦略が手動でアクティブ化されたとき', category: 'success', defaultEnabled: true },
    { id: 'strategy_deactivated', name: '戦略停止', description: '戦略が停止されたとき', category: 'info', defaultEnabled: true },
    { id: 'strategy_auto_activated', name: '戦略自動アクティベート', description: '条件により戦略が自動起動したとき', category: 'success', defaultEnabled: true },
    { id: 'strategy_performance_warning', name: '戦略パフォーマンス低下', description: '戦略の成功率が低下したとき', category: 'warning', defaultEnabled: true },
    { id: 'strategy_roi_warning', name: '戦略ROI低下', description: '戦略のROIが低下したとき', category: 'warning', defaultEnabled: true },
    { id: 'strategy_error_escalation', name: '戦略エラーのエスカレーション', description: '戦略エラーがエスカレートされたとき', category: 'warning', defaultEnabled: true },
    { id: 'strategy_execution_abort', name: '戦略実行中断', description: '戦略の実行が中断されたとき', category: 'error', defaultEnabled: true },
    // 損失制限
    { id: 'loss_limit_reached', name: '損失制限到達', description: '損失制限に到達し、操作がブロックされたとき', category: 'critical', defaultEnabled: true },
    // 改善関連
    { id: 'improvement_verified', name: '改善検証完了', description: '自動改善の検証が完了したとき', category: 'info', defaultEnabled: false },
    { id: 'improvement_auto_implemented', name: '改善の自動実装', description: '改善が自動的に実装されたとき', category: 'success', defaultEnabled: true },
    { id: 'improvement_rollback', name: '改善のロールバック', description: '改善がロールバックされたとき', category: 'warning', defaultEnabled: true },
    { id: 'auto_improve_complete', name: '自動改善処理完了', description: '自動改善処理のサイクル完了', category: 'info', defaultEnabled: false },
    // 承認関連
    { id: 'request_approved', name: 'リクエスト承認', description: '承認リクエストが承認されたとき', category: 'success', defaultEnabled: true },
    { id: 'request_rejected', name: 'リクエスト拒否', description: '承認リクエストが拒否されたとき', category: 'error', defaultEnabled: true },
    // GitHub関連
    { id: 'github_secret_detected', name: '機密ファイル検出', description: 'コミットに機密ファイルが含まれるとき', category: 'warning', defaultEnabled: true },
    { id: 'github_push_success', name: 'GitHub更新', description: 'GitHubへのプッシュ成功', category: 'success', defaultEnabled: false },
    // パターン・研究関連
    { id: 'pattern_extracted', name: '成功パターン検出', description: '新しい成功パターンが検出されたとき', category: 'info', defaultEnabled: false },
    { id: 'trend_detected', name: '技術トレンド検出', description: '注目の技術トレンドが検出されたとき', category: 'info', defaultEnabled: false },
    { id: 'opportunity_found', name: '収益機会発見', description: '新しい収益機会が発見されたとき', category: 'info', defaultEnabled: true },
    { id: 'tech_research_findings', name: '開発手法調査', description: '開発手法・ツール調査の発見', category: 'info', defaultEnabled: false },
    { id: 'existing_strategy_findings', name: '戦略調査の発見', description: '既存戦略に関する重要な発見', category: 'info', defaultEnabled: false },
    // 診断関連
    { id: 'diagnostic_critical', name: 'システム診断:重大', description: 'クリティカルな問題が検出されたとき', category: 'critical', defaultEnabled: true },
    { id: 'diagnostic_warning', name: 'システム診断:警告', description: '注意が必要な問題が検出されたとき', category: 'warning', defaultEnabled: true },
    // 実験関連
    { id: 'experiment_phase_update', name: '実験フェーズ更新', description: '実験のフェーズが進行したとき', category: 'info', defaultEnabled: false },
    { id: 'experiment_aborted', name: '実験中止', description: '実験が中止されたとき', category: 'warning', defaultEnabled: true },
    { id: 'experiment_success', name: '実験成功', description: '実験が成功し本採用されたとき', category: 'success', defaultEnabled: true },
    // プラットフォーム関連
    { id: 'zenn_auth_required', name: 'Zenn認証が必要', description: 'Zennへのログインが必要なとき', category: 'warning', defaultEnabled: true },
    { id: 'zenn_article_ready', name: 'Zenn記事準備完了', description: 'Zenn記事がローカルに保存されたとき', category: 'info', defaultEnabled: true },
    { id: 'platform_post_failed', name: '投稿失敗', description: 'プラットフォームへの投稿が失敗したとき', category: 'warning', defaultEnabled: true },
    { id: 'article_publish_ready', name: '記事公開準備完了', description: 'アフィリエイト記事が準備完了', category: 'info', defaultEnabled: true },
    { id: 'job_application_ready', name: '案件応募準備完了', description: 'フリーランス案件への応募準備完了', category: 'info', defaultEnabled: true },
    { id: 'product_listing_ready', name: '商品出品準備完了', description: 'デジタル商品の出品準備完了', category: 'info', defaultEnabled: true },
];
// カテゴリ情報
export const NOTIFICATION_CATEGORIES = {
    info: { name: '情報', icon: 'ℹ️', description: 'ステータス更新、レポートなど' },
    success: { name: '成功', icon: '✅', description: '完了通知、成功通知など' },
    warning: { name: '警告', icon: '⚠️', description: '注意が必要な通知' },
    error: { name: 'エラー', icon: '❌', description: 'エラー通知' },
    critical: { name: '重大', icon: '🚨', description: '緊急対応が必要な通知' },
    audit: { name: '監査', icon: '📋', description: '監査ログ' },
    suggestionResponse: { name: '提案への回答', icon: '💬', description: '提案に対する回答' },
};
const DEFAULT_SETTINGS = {
    discord: {
        info: true,
        success: true,
        warning: true,
        error: true,
        critical: true,
        audit: false,
        suggestionResponse: true,
    },
    // 個別項目のデフォルト設定はNOTIFICATION_ITEMSから生成
    items: Object.fromEntries(NOTIFICATION_ITEMS.map(item => [item.id, item.defaultEnabled])),
};
function loadSettings() {
    try {
        if (existsSync(SETTINGS_PATH)) {
            const content = readFileSync(SETTINGS_PATH, 'utf-8');
            const loaded = JSON.parse(content);
            // デフォルト設定とマージ（後方互換性）
            return {
                discord: { ...DEFAULT_SETTINGS.discord, ...loaded.discord },
                items: { ...DEFAULT_SETTINGS.items, ...(loaded.items || {}) },
            };
        }
    }
    catch (error) {
        logger.warn('Failed to load notification settings, using defaults', { error });
    }
    return DEFAULT_SETTINGS;
}
// 項目IDが有効かどうかをチェック
function isItemEnabled(settings, itemId) {
    // 項目ごとの設定があればそれを使用
    if (settings.items && typeof settings.items[itemId] === 'boolean') {
        return settings.items[itemId];
    }
    // 項目の定義を取得してカテゴリの設定を使用
    const itemMeta = NOTIFICATION_ITEMS.find(item => item.id === itemId);
    if (itemMeta) {
        return settings.discord[itemMeta.category];
    }
    // 不明な項目はデフォルトでtrue
    return true;
}
function saveHistory(entry) {
    try {
        if (!existsSync(WORKSPACE_DIR)) {
            mkdirSync(WORKSPACE_DIR, { recursive: true });
        }
        let history = [];
        if (existsSync(HISTORY_PATH)) {
            const content = readFileSync(HISTORY_PATH, 'utf-8');
            history = JSON.parse(content);
        }
        // 最新100件のみ保持
        history.unshift(entry);
        if (history.length > 100) {
            history = history.slice(0, 100);
        }
        writeFileSync(HISTORY_PATH, JSON.stringify(history, null, 2));
    }
    catch (error) {
        logger.warn('Failed to save notification history', { error });
    }
}
function generateId() {
    return `notif_${Date.now()}_${Math.random().toString(36).substring(2, 9)}`;
}
const TYPE_COLORS = {
    info: 0x3498db,
    success: 0x2ecc71,
    warning: 0xf1c40f,
    error: 0xe74c3c,
    critical: 0x9b59b6,
    audit: 0x95a5a6,
    suggestionResponse: 0x1abc9c,
};
export class DiscordNotifier {
    config;
    queue = [];
    sending = false;
    constructor(config = {}) {
        this.config = {
            username: config.username ?? 'AutoClaudeKMP',
            avatarUrl: config.avatarUrl,
            webhookUrl: config.webhookUrl ?? process.env.DISCORD_WEBHOOK_URL,
            channelId: config.channelId,
        };
        if (!this.config.webhookUrl) {
            logger.warn('Discord webhook URL not configured');
        }
        else {
            logger.info('DiscordNotifier initialized');
        }
    }
    async send(message) {
        const historyEntry = {
            id: generateId(),
            type: message.type,
            title: message.title,
            description: message.description,
            timestamp: new Date().toISOString(),
            sent: false,
            itemId: message.itemId,
        };
        // 設定を確認
        const settings = loadSettings();
        // 個別項目IDが指定されている場合は、項目ごとの設定をチェック
        if (message.itemId) {
            if (!isItemEnabled(settings, message.itemId)) {
                const itemMeta = NOTIFICATION_ITEMS.find(item => item.id === message.itemId);
                historyEntry.reason = `通知項目「${itemMeta?.name || message.itemId}」は無効化されています`;
                saveHistory(historyEntry);
                logger.debug('Skipping notification (disabled by item settings)', { itemId: message.itemId, title: message.title });
                return false;
            }
        }
        else {
            // 従来のカテゴリ単位のチェック（後方互換性）
            if (!settings.discord[message.type]) {
                historyEntry.reason = `通知タイプ「${message.type}」は無効化されています`;
                saveHistory(historyEntry);
                logger.debug('Skipping notification (disabled by settings)', { type: message.type, title: message.title });
                return false;
            }
        }
        if (!this.config.webhookUrl) {
            historyEntry.reason = 'Webhook URLが未設定';
            saveHistory(historyEntry);
            logger.debug('Skipping Discord notification (no webhook)', { title: message.title });
            return false;
        }
        const embed = this.createEmbed(message);
        try {
            const response = await fetch(this.config.webhookUrl, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({
                    username: this.config.username,
                    avatar_url: this.config.avatarUrl,
                    embeds: [embed],
                }),
            });
            if (!response.ok) {
                const text = await response.text();
                historyEntry.reason = `Discord API エラー: ${response.status}`;
                saveHistory(historyEntry);
                logger.error('Discord API error', { status: response.status, body: text });
                return false;
            }
            historyEntry.sent = true;
            saveHistory(historyEntry);
            logger.debug('Discord notification sent', { title: message.title });
            return true;
        }
        catch (error) {
            historyEntry.reason = `送信エラー: ${error instanceof Error ? error.message : String(error)}`;
            saveHistory(historyEntry);
            logger.error('Failed to send Discord notification', { error, title: message.title });
            return false;
        }
    }
    async sendInfo(title, description, itemId) {
        return this.send({ type: 'info', title, description, itemId });
    }
    async sendSuccess(title, description, itemId) {
        return this.send({ type: 'success', title, description, itemId });
    }
    async sendWarning(title, description, itemId) {
        return this.send({ type: 'warning', title, description, itemId });
    }
    async sendError(title, description, itemId) {
        return this.send({ type: 'error', title, description, itemId });
    }
    async sendCritical(message) {
        return this.send({ ...message, type: 'critical' });
    }
    async sendSuggestionResponse(title, description, fields, itemId) {
        return this.send({ type: 'suggestionResponse', title, description, fields, itemId: itemId ?? 'suggestion_response' });
    }
    async sendRateLimitAlert(isActive, details) {
        return this.send({
            type: isActive ? 'warning' : 'info',
            title: isActive ? 'レートリミット検出' : 'レートリミット解除',
            description: details,
            itemId: 'rate_limit',
        });
    }
    createEmbed(message) {
        const typeIcons = {
            info: 'ℹ️',
            success: '✅',
            warning: '⚠️',
            error: '❌',
            critical: '🚨',
            audit: '📋',
            suggestionResponse: '💬',
        };
        return {
            title: `${typeIcons[message.type]} ${message.title}`,
            description: message.description,
            color: TYPE_COLORS[message.type],
            fields: message.fields,
            timestamp: (message.timestamp ?? new Date()).toISOString(),
            footer: { text: 'AutoClaudeKMP' },
        };
    }
    isConfigured() {
        return !!this.config.webhookUrl;
    }
    setWebhookUrl(url) {
        this.config.webhookUrl = url;
        logger.info('Discord webhook URL updated');
    }
}
let instance = null;
export function getDiscordNotifier(config) {
    if (!instance) {
        instance = new DiscordNotifier(config);
    }
    return instance;
}
//# sourceMappingURL=discord.js.map