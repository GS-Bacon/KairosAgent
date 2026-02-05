import { AIProvider } from "./provider.js";
import { ClaudeProvider } from "./claude-provider.js";
import { OpenCodeProvider } from "./opencode-provider.js";
import { eventBus, CriticalAlert } from "../core/event-bus.js";
import { logger } from "../core/logger.js";

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
  failureThreshold: 3,
  degradedThreshold: 1,
  repairCooldown: 300000,
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
}

let globalHealthMonitor: ProviderHealthMonitor | null = null;

export function initializeHealthMonitor(
  providers: AIProvider[],
  config?: Partial<HealthMonitorConfig>
): ProviderHealthMonitor {
  globalHealthMonitor = new ProviderHealthMonitor(config);
  for (const provider of providers) {
    globalHealthMonitor.registerProvider(provider);
  }
  return globalHealthMonitor;
}

export function getHealthMonitor(): ProviderHealthMonitor | null {
  return globalHealthMonitor;
}
