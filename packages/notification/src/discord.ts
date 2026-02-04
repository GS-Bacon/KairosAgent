import { RiskLevel, getLogger } from '@auto-claude/core';
import { existsSync, readFileSync, writeFileSync, mkdirSync } from 'fs';
import { join, dirname } from 'path';

const logger = getLogger('notification:discord');

// 設定ファイルのパス
const WORKSPACE_DIR = join(process.cwd(), 'workspace');
const SETTINGS_PATH = join(WORKSPACE_DIR, 'notification-settings.json');
const HISTORY_PATH = join(WORKSPACE_DIR, 'notification-history.json');

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

const DEFAULT_SETTINGS: NotificationSettings = {
  discord: {
    info: true,
    success: true,
    warning: true,
    error: true,
    critical: true,
    audit: false,
    suggestionResponse: true,
  },
};

function loadSettings(): NotificationSettings {
  try {
    if (existsSync(SETTINGS_PATH)) {
      const content = readFileSync(SETTINGS_PATH, 'utf-8');
      const loaded = JSON.parse(content);
      // デフォルト設定とマージ（後方互換性）
      return {
        discord: { ...DEFAULT_SETTINGS.discord, ...loaded.discord },
      };
    }
  } catch (error) {
    logger.warn('Failed to load notification settings, using defaults', { error });
  }
  return DEFAULT_SETTINGS;
}

function saveHistory(entry: NotificationHistoryEntry): void {
  try {
    if (!existsSync(WORKSPACE_DIR)) {
      mkdirSync(WORKSPACE_DIR, { recursive: true });
    }

    let history: NotificationHistoryEntry[] = [];
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
  } catch (error) {
    logger.warn('Failed to save notification history', { error });
  }
}

function generateId(): string {
  return `notif_${Date.now()}_${Math.random().toString(36).substring(2, 9)}`;
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
  fields?: Array<{ name: string; value: string; inline?: boolean }>;
  timestamp?: Date;
}

export interface DiscordEmbed {
  title: string;
  description?: string;
  color: number;
  fields?: Array<{ name: string; value: string; inline?: boolean }>;
  timestamp?: string;
  footer?: { text: string };
}

const TYPE_COLORS: Record<DiscordMessage['type'], number> = {
  info: 0x3498db,
  success: 0x2ecc71,
  warning: 0xf1c40f,
  error: 0xe74c3c,
  critical: 0x9b59b6,
  audit: 0x95a5a6,
  suggestionResponse: 0x1abc9c,
};

export class DiscordNotifier {
  private config: DiscordConfig;
  private queue: DiscordMessage[] = [];
  private sending: boolean = false;

  constructor(config: DiscordConfig = {}) {
    this.config = {
      username: config.username ?? 'AutoClaudeKMP',
      avatarUrl: config.avatarUrl,
      webhookUrl: config.webhookUrl ?? process.env.DISCORD_WEBHOOK_URL,
      channelId: config.channelId,
    };

    if (!this.config.webhookUrl) {
      logger.warn('Discord webhook URL not configured');
    } else {
      logger.info('DiscordNotifier initialized');
    }
  }

  async send(message: DiscordMessage): Promise<boolean> {
    const historyEntry: NotificationHistoryEntry = {
      id: generateId(),
      type: message.type,
      title: message.title,
      description: message.description,
      timestamp: new Date().toISOString(),
      sent: false,
    };

    // 設定を確認
    const settings = loadSettings();
    if (!settings.discord[message.type]) {
      historyEntry.reason = `通知タイプ「${message.type}」は無効化されています`;
      saveHistory(historyEntry);
      logger.debug('Skipping notification (disabled by settings)', { type: message.type, title: message.title });
      return false;
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
    } catch (error) {
      historyEntry.reason = `送信エラー: ${error instanceof Error ? error.message : String(error)}`;
      saveHistory(historyEntry);
      logger.error('Failed to send Discord notification', { error, title: message.title });
      return false;
    }
  }

  async sendInfo(title: string, description?: string): Promise<boolean> {
    return this.send({ type: 'info', title, description });
  }

  async sendSuccess(title: string, description?: string): Promise<boolean> {
    return this.send({ type: 'success', title, description });
  }

  async sendWarning(title: string, description?: string): Promise<boolean> {
    return this.send({ type: 'warning', title, description });
  }

  async sendError(title: string, description?: string): Promise<boolean> {
    return this.send({ type: 'error', title, description });
  }

  async sendCritical(message: Omit<DiscordMessage, 'type'>): Promise<boolean> {
    return this.send({ ...message, type: 'critical' });
  }

  async sendSuggestionResponse(title: string, description?: string, fields?: DiscordMessage['fields']): Promise<boolean> {
    return this.send({ type: 'suggestionResponse', title, description, fields });
  }

  private createEmbed(message: DiscordMessage): DiscordEmbed {
    const typeIcons: Record<DiscordMessage['type'], string> = {
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

  isConfigured(): boolean {
    return !!this.config.webhookUrl;
  }

  setWebhookUrl(url: string): void {
    this.config.webhookUrl = url;
    logger.info('Discord webhook URL updated');
  }
}

let instance: DiscordNotifier | null = null;

export function getDiscordNotifier(config?: DiscordConfig): DiscordNotifier {
  if (!instance) {
    instance = new DiscordNotifier(config);
  }
  return instance;
}
