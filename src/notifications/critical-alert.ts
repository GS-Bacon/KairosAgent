import { CriticalAlert, eventBus } from "../core/event-bus.js";
import { logger } from "../core/logger.js";
import { getHealthMonitor } from "../ai/provider-health.js";

export interface WebhookConfig {
  url: string;
  headers?: Record<string, string>;
}

export interface AlertConfig {
  webhooks?: WebhookConfig[];
  logLevel?: "error" | "warn" | "info";
}

class CriticalAlertManager {
  private config: AlertConfig = { logLevel: "error" };
  private alertHistory: CriticalAlert[] = [];
  private maxHistory = 100;

  constructor() {
    this.setupEventListener();
  }

  private setupEventListener(): void {
    eventBus.on("critical_alert", (event) => {
      this.handleAlert(event.alert);
    });
  }

  configure(config: Partial<AlertConfig>): void {
    this.config = { ...this.config, ...config };
  }

  private handleAlert(alert: CriticalAlert): void {
    this.alertHistory.push(alert);
    if (this.alertHistory.length > this.maxHistory) {
      this.alertHistory.shift();
    }

    this.logAlert(alert);

    if (this.config.webhooks && this.config.webhooks.length > 0) {
      this.sendWebhooks(alert);
    }
  }

  private logAlert(alert: CriticalAlert): void {
    const logMessage = `CRITICAL ALERT: ${alert.message}`;
    const logData = {
      alertType: alert.alertType,
      affectedProviders: alert.affectedProviders,
      context: alert.context,
    };

    switch (this.config.logLevel) {
      case "warn":
        logger.warn(logMessage, logData);
        break;
      case "info":
        logger.info(logMessage, logData);
        break;
      default:
        logger.error(logMessage, logData);
    }
  }

  private async sendWebhooks(alert: CriticalAlert): Promise<void> {
    if (!this.config.webhooks) return;

    for (const webhook of this.config.webhooks) {
      try {
        const response = await fetch(webhook.url, {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            ...webhook.headers,
          },
          body: JSON.stringify({
            type: "critical_alert",
            alert: {
              alertType: alert.alertType,
              message: alert.message,
              timestamp: alert.timestamp.toISOString(),
              affectedProviders: alert.affectedProviders,
            },
            source: "kairos-agent",
          }),
        });

        if (!response.ok) {
          logger.error("Webhook notification failed", {
            url: webhook.url,
            status: response.status,
          });
        } else {
          logger.info("Webhook notification sent", { url: webhook.url });
        }
      } catch (err) {
        logger.error("Webhook notification error", {
          url: webhook.url,
          error: err instanceof Error ? err.message : String(err),
        });
      }
    }
  }

  getAlertHistory(): CriticalAlert[] {
    return [...this.alertHistory];
  }

  getActiveAlerts(): CriticalAlert[] {
    const monitor = getHealthMonitor();
    if (!monitor) {
      return [];
    }
    return monitor.getCriticalAlerts();
  }

  clearHistory(): void {
    this.alertHistory = [];
  }
}

export const criticalAlertManager = new CriticalAlertManager();
