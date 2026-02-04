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
}
export interface NotificationHistoryEntry {
    id: string;
    type: DiscordMessage['type'];
    title: string;
    description?: string;
    timestamp: string;
    sent: boolean;
    reason?: string;
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
    sendInfo(title: string, description?: string): Promise<boolean>;
    sendSuccess(title: string, description?: string): Promise<boolean>;
    sendWarning(title: string, description?: string): Promise<boolean>;
    sendError(title: string, description?: string): Promise<boolean>;
    sendCritical(message: Omit<DiscordMessage, 'type'>): Promise<boolean>;
    sendSuggestionResponse(title: string, description?: string, fields?: DiscordMessage['fields']): Promise<boolean>;
    sendRateLimitAlert(isActive: boolean, details?: string): Promise<boolean>;
    private createEmbed;
    isConfigured(): boolean;
    setWebhookUrl(url: string): void;
}
export declare function getDiscordNotifier(config?: DiscordConfig): DiscordNotifier;
//# sourceMappingURL=discord.d.ts.map