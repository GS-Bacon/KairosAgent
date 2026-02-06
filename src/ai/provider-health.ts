import { AIProvider } from "./provider.js";
import { ClaudeProvider } from "./claude-provider.js";
import { OpenCodeProvider } from "./opencode-provider.js";
import { eventBus, CriticalAlert } from "../core/event-bus.js";
import { logger } from "../core/logger.js";
import { PROVIDER_HEALTH } from "../config/constants.js";

export type ProviderStatus = "healthy" | "degraded" | "broken";

export interface ProviderHealth {
  name: string;
  status: ProviderStatus;
  consecutiveFailures: number;
  lastSuccess: Date | null;
  lastFailure: Date | null;
  lastError: string | null;
}

interface HealthMonitorConfig {
  failureThreshold: number;
  degradedThreshold: number;
  repairCooldown: number;
}

const DEFAULT_CONFIG: HealthMonitorConfig = {
  failureThreshold: PROVIDER_HEALTH.FAILURE_THRESHOLD,
  degradedThreshold: PROVIDER_HEALTH.DEGRADED_THRESHOLD,
  repairCooldown: PROVIDER_HEALTH.REPAIR_COOLDOWN_MS,
};

export class ProviderHealthMonitor {
  private healthState: Map<string, ProviderHealth> = new Map();
  private providers: Map<string, AIProvider> = new Map();
  private lastRepairAttempt: Map<string, Date> = new Map();
  private config: HealthMonitorConfig;

  constructor(config: Partial<HealthMonitorConfig> = {}) {
    this.config = { ...DEFAULT_CONFIG, ...config };
  }

  registerProvider(provider: AIProvider): void {
    this.providers.set(provider.name, provider);
    this.healthState.set(provider.name, {
      name: provider.name,
      status: "healthy",
      consecutiveFailures: 0,
      lastSuccess: null,
      lastFailure: null,
      lastError: null,
    });
    logger.info("Provider registered for health monitoring", { provider: provider.name });
  }

  getHealth(providerName: string): ProviderHealth | undefined {
    return this.healthState.get(providerName);
  }

  getAllHealth(): ProviderHealth[] {
    return Array.from(this.healthState.values());
  }

  recordSuccess(providerName: string): void {
    const health = this.healthState.get(providerName);
    if (!health) return;

    const oldStatus = health.status;
    health.consecutiveFailures = 0;
    health.lastSuccess = new Date();
    health.status = "healthy";

    if (oldStatus !== "healthy") {
      logger.info("Provider recovered", { provider: providerName, oldStatus });
      eventBus.emit({
        type: "provider_health_changed",
        provider: providerName,
        oldStatus,
        newStatus: "healthy",
        timestamp: new Date(),
      });
    }
  }

  recordFailure(providerName: string, error: Error): void {
    const health = this.healthState.get(providerName);
    if (!health) return;

    const oldStatus = health.status;
    health.consecutiveFailures++;
    health.lastFailure = new Date();
    health.lastError = error.message;

    if (health.consecutiveFailures >= this.config.failureThreshold) {
      health.status = "broken";
    } else if (health.consecutiveFailures >= this.config.degradedThreshold) {
      health.status = "degraded";
    }

    logger.warn("Provider failure recorded", {
      provider: providerName,
      consecutiveFailures: health.consecutiveFailures,
      status: health.status,
      error: error.message,
    });

    if (oldStatus !== health.status) {
      eventBus.emit({
        type: "provider_health_changed",
        provider: providerName,
        oldStatus,
        newStatus: health.status,
        timestamp: new Date(),
      });
    }

    this.checkCriticalState();
  }

  private checkCriticalState(): void {
    const allHealth = this.getAllHealth();
    const brokenProviders = allHealth.filter((h) => h.status === "broken");

    if (brokenProviders.length === allHealth.length && allHealth.length > 0) {
      const alert: CriticalAlert = {
        alertType: "ai_providers_broken",
        message: "All AI providers are broken. Manual intervention required.",
        timestamp: new Date(),
        affectedProviders: brokenProviders.map((h) => h.name),
      };

      logger.error("CRITICAL: All AI providers are broken", {
        providers: brokenProviders.map((h) => ({
          name: h.name,
          failures: h.consecutiveFailures,
          lastError: h.lastError,
        })),
      });

      eventBus.emit({ type: "critical_alert", alert });
    }
  }

  canRepair(brokenProviderName: string): boolean {
    const lastAttempt = this.lastRepairAttempt.get(brokenProviderName);
    if (lastAttempt) {
      const elapsed = Date.now() - lastAttempt.getTime();
      if (elapsed < this.config.repairCooldown) {
        return false;
      }
    }

    for (const [name, health] of this.healthState) {
      if (name !== brokenProviderName && health.status === "healthy") {
        return true;
      }
    }
    return false;
  }

  getRepairProvider(brokenProviderName: string): AIProvider | null {
    for (const [name, health] of this.healthState) {
      if (name !== brokenProviderName && health.status === "healthy") {
        return this.providers.get(name) || null;
      }
    }
    return null;
  }

  async attemptCrossRepair(brokenProviderName: string): Promise<boolean> {
    if (!this.canRepair(brokenProviderName)) {
      logger.warn("Cannot attempt repair", {
        provider: brokenProviderName,
        reason: "No healthy providers or cooldown active",
      });
      return false;
    }

    const repairProvider = this.getRepairProvider(brokenProviderName);
    if (!repairProvider) {
      return false;
    }

    this.lastRepairAttempt.set(brokenProviderName, new Date());

    logger.info("Attempting cross-repair", {
      broken: brokenProviderName,
      repairWith: repairProvider.name,
    });

    try {
      const repairPrompt = this.generateRepairPrompt(brokenProviderName);
      const repairSuggestion = await repairProvider.chat(repairPrompt);

      logger.info("Cross-repair suggestion received", {
        broken: brokenProviderName,
        suggestionLength: repairSuggestion.length,
      });

      return true;
    } catch (err) {
      logger.error("Cross-repair failed", {
        broken: brokenProviderName,
        repairProvider: repairProvider.name,
        error: err instanceof Error ? err.message : String(err),
      });
      return false;
    }
  }

  private generateRepairPrompt(brokenProviderName: string): string {
    const health = this.healthState.get(brokenProviderName);
    return `AI Provider "${brokenProviderName}" has failed ${health?.consecutiveFailures || 0} times consecutively.
Last error: ${health?.lastError || "Unknown"}

Please analyze this error and suggest a fix. If this is a configuration or integration issue, provide specific steps to resolve it.`;
  }

  async testProvider(providerName: string): Promise<boolean> {
    const provider = this.providers.get(providerName);
    if (!provider) {
      return false;
    }

    try {
      const available = await provider.isAvailable();
      if (!available) {
        return false;
      }

      const response = await provider.chat("Respond with OK if you are working.");
      const success = response.toLowerCase().includes("ok");

      if (success) {
        this.recordSuccess(providerName);
      }
      return success;
    } catch (err) {
      this.recordFailure(providerName, err instanceof Error ? err : new Error(String(err)));
      return false;
    }
  }

  getCriticalAlerts(): CriticalAlert[] {
    const alerts: CriticalAlert[] = [];
    const allHealth = this.getAllHealth();
    const brokenProviders = allHealth.filter((h) => h.status === "broken");

    if (brokenProviders.length === allHealth.length && allHealth.length > 0) {
      alerts.push({
        alertType: "ai_providers_broken",
        message: "All AI providers are broken. Manual intervention required.",
        timestamp: new Date(),
        affectedProviders: brokenProviders.map((h) => h.name),
      });
    }

    return alerts;
  }

  /**
   * 全プロバイダーの状態レポートを取得
   */
  getHealthReport(): {
    providers: Record<string, ProviderHealth>;
    overallStatus: ProviderStatus;
    criticalAlerts: CriticalAlert[];
  } {
    const allHealth = this.getAllHealth();
    const providers: Record<string, ProviderHealth> = {};

    for (const health of allHealth) {
      providers[health.name] = health;
    }

    let overallStatus: ProviderStatus = "healthy";
    const brokenCount = allHealth.filter((h) => h.status === "broken").length;
    const degradedCount = allHealth.filter((h) => h.status === "degraded").length;

    if (brokenCount === allHealth.length && allHealth.length > 0) {
      overallStatus = "broken";
    } else if (brokenCount > 0 || degradedCount > 0) {
      overallStatus = "degraded";
    }

    return {
      providers,
      overallStatus,
      criticalAlerts: this.getCriticalAlerts(),
    };
  }

  /**
   * フォールバック順序を取得（healthyなプロバイダーを優先）
   */
  getFallbackOrder(): AIProvider[] {
    const allHealth = this.getAllHealth();
    const orderedProviders: AIProvider[] = [];

    // 優先度: healthy > degraded > broken
    const statusOrder: ProviderStatus[] = ["healthy", "degraded", "broken"];

    for (const status of statusOrder) {
      for (const health of allHealth) {
        if (health.status === status) {
          const provider = this.providers.get(health.name);
          if (provider) {
            orderedProviders.push(provider);
          }
        }
      }
    }

    return orderedProviders;
  }

  /**
   * brokenプロバイダーの回復をチェック
   */
  async checkBrokenProviderRecovery(): Promise<void> {
    const allHealth = this.getAllHealth();
    const brokenProviders = allHealth.filter((h) => h.status === "broken");

    for (const health of brokenProviders) {
      // 最後の失敗から5分以上経過している場合のみテスト
      if (health.lastFailure) {
        const elapsed = Date.now() - health.lastFailure.getTime();
        if (elapsed < PROVIDER_HEALTH.RECOVERY_CHECK_INTERVAL_MS) {
          continue;
        }
      }

      logger.info("Testing broken provider for recovery", {
        provider: health.name,
      });

      const recovered = await this.testProvider(health.name);
      if (recovered) {
        logger.info("Provider recovered", { provider: health.name });
      } else {
        logger.debug("Provider still broken", { provider: health.name });
      }
    }
  }

  /**
   * フォールバック付きで関数を実行
   */
  async executeWithFallback<T>(
    operation: (provider: AIProvider) => Promise<T>
  ): Promise<T> {
    const orderedProviders = this.getFallbackOrder();

    if (orderedProviders.length === 0) {
      throw new Error("No providers available");
    }

    let lastError: Error | null = null;

    for (const provider of orderedProviders) {
      const health = this.healthState.get(provider.name);
      if (health?.status === "broken") {
        // brokenプロバイダーはスキップ（ただし全てbrokenなら試す）
        if (orderedProviders.some((p) => this.healthState.get(p.name)?.status !== "broken")) {
          continue;
        }
      }

      try {
        const result = await operation(provider);
        this.recordSuccess(provider.name);
        return result;
      } catch (err) {
        lastError = err instanceof Error ? err : new Error(String(err));
        this.recordFailure(provider.name, lastError);
        logger.warn("Provider failed, trying fallback", {
          provider: provider.name,
          error: lastError.message,
        });
      }
    }

    throw lastError || new Error("All providers failed");
  }
}

let globalHealthMonitor: ProviderHealthMonitor | null = null;
let recoveryCheckInterval: NodeJS.Timeout | null = null;

export function initializeHealthMonitor(
  providers: AIProvider[],
  config?: Partial<HealthMonitorConfig>
): ProviderHealthMonitor {
  globalHealthMonitor = new ProviderHealthMonitor(config);
  for (const provider of providers) {
    globalHealthMonitor.registerProvider(provider);
  }

  // 定期的にbrokenプロバイダーの回復をチェック（5分ごと）
  if (recoveryCheckInterval) {
    clearInterval(recoveryCheckInterval);
  }
  recoveryCheckInterval = setInterval(async () => {
    try {
      if (globalHealthMonitor) {
        await globalHealthMonitor.checkBrokenProviderRecovery();
      }
    } catch (err) {
      logger.error("Provider recovery check failed", {
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }, PROVIDER_HEALTH.RECOVERY_CHECK_INTERVAL_MS);

  return globalHealthMonitor;
}

export function getHealthMonitor(): ProviderHealthMonitor | null {
  return globalHealthMonitor;
}

/**
 * ヘルスモニターを停止
 */
export function stopHealthMonitor(): void {
  if (recoveryCheckInterval) {
    clearInterval(recoveryCheckInterval);
    recoveryCheckInterval = null;
  }
  globalHealthMonitor = null;
}
