export type NotificationItemId = 'system_startup' | 'system_shutdown' | 'heartbeat' | 'heartbeat_failure' | 'uncaught_exception' | 'rate_limit' | 'daily_report' | 'weekly_report' | 'weekly_retrospective' | 'suggestion_response' | 'suggestion_auto_reject' | 'suggestion_re_evaluate' | 'suggestion_auto_implement' | 'suggestion_implement_failed' | 'strategy_execution_complete' | 'strategy_execution_failed' | 'strategy_cycle_complete' | 'strategy_auto_stop' | 'strategy_limit' | 'strategy_activated' | 'strategy_deactivated' | 'strategy_auto_activated' | 'strategy_performance_warning' | 'strategy_roi_warning' | 'strategy_error_escalation' | 'strategy_execution_abort' | 'loss_limit_reached' | 'improvement_verified' | 'improvement_auto_implemented' | 'improvement_rollback' | 'auto_improve_complete' | 'request_approved' | 'request_rejected' | 'github_secret_detected' | 'github_push_success' | 'pattern_extracted' | 'trend_detected' | 'opportunity_found' | 'tech_research_findings' | 'existing_strategy_findings' | 'diagnostic_critical' | 'diagnostic_warning' | 'experiment_phase_update' | 'experiment_aborted' | 'experiment_success' | 'zenn_auth_required' | 'zenn_article_ready' | 'platform_post_failed' | 'article_publish_ready' | 'job_application_ready' | 'product_listing_ready';
export interface NotificationItemMeta {
    id: NotificationItemId;
    name: string;
    description: string;
    category: 'info' | 'success' | 'warning' | 'error' | 'critical' | 'audit' | 'suggestionResponse';
    defaultEnabled: boolean;
}
export declare const NOTIFICATION_ITEMS: NotificationItemMeta[];
export declare const NOTIFICATION_CATEGORIES: {
    info: {
        name: string;
        icon: string;
        description: string;
    };
    success: {
        name: string;
        icon: string;
        description: string;
    };
    warning: {
        name: string;
        icon: string;
        description: string;
    };
    error: {
        name: string;
        icon: string;
        description: string;
    };
    critical: {
        name: string;
        icon: string;
        description: string;
    };
    audit: {
        name: string;
        icon: string;
        description: string;
    };
    suggestionResponse: {
        name: string;
        icon: string;
        description: string;
    };
};
export interface NotificationSettings {
    discord: {
        info: boolean;
        success: boolean;
        warning: boolean;
        error: boolean;
        critical: boolean;
        audit: boolean;
        suggestionResponse: boolean;
    };
    items?: Partial<Record<NotificationItemId, boolean>>;
}
export interface NotificationHistoryEntry {
    id: string;
    type: DiscordMessage['type'];
    title: string;
    description?: string;
    timestamp: string;
    sent: boolean;
    reason?: string;
    itemId?: NotificationItemId;
}
export interface DiscordConfig {
    webhookUrl?: string;
    channelId?: string;
    username?: string;
    avatarUrl?: string;
}
export interface DiscordMessage {
    type: 'info' | 'success' | 'warning' | 'error' | 'critical' | 'audit' | 'suggestionResponse';
    title: string;
    description?: string;
    fields?: Array<{
        name: string;
        value: string;
        inline?: boolean;
    }>;
    timestamp?: Date;
    itemId?: NotificationItemId;
}
export interface DiscordEmbed {
    title: string;
    description?: string;
    color: number;
    fields?: Array<{
        name: string;
        value: string;
        inline?: boolean;
    }>;
    timestamp?: string;
    footer?: {
        text: string;
    };
}
export declare class DiscordNotifier {
    private config;
    private queue;
    private sending;
    constructor(config?: DiscordConfig);
    send(message: DiscordMessage): Promise<boolean>;
    sendInfo(title: string, description?: string, itemId?: NotificationItemId): Promise<boolean>;
    sendSuccess(title: string, description?: string, itemId?: NotificationItemId): Promise<boolean>;
    sendWarning(title: string, description?: string, itemId?: NotificationItemId): Promise<boolean>;
    sendError(title: string, description?: string, itemId?: NotificationItemId): Promise<boolean>;
    sendCritical(message: Omit<DiscordMessage, 'type'>): Promise<boolean>;
    sendSuggestionResponse(title: string, description?: string, fields?: DiscordMessage['fields'], itemId?: NotificationItemId): Promise<boolean>;
    sendRateLimitAlert(isActive: boolean, details?: string): Promise<boolean>;
    private createEmbed;
    isConfigured(): boolean;
    setWebhookUrl(url: string): void;
}
export declare function getDiscordNotifier(config?: DiscordConfig): DiscordNotifier;
//# sourceMappingURL=discord.d.ts.map