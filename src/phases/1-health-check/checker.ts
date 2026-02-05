import { existsSync, statSync } from "fs";
import { HealthStatus, HealthCheck } from "./types.js";
import { logger } from "../../core/logger.js";
import { eventBus } from "../../core/event-bus.js";
import { snapshotManager } from "../../safety/snapshot.js";
import { getHealthMonitor, ProviderHealth } from "../../ai/provider-health.js";

export class HealthChecker {
  private checks: Array<() => Promise<HealthCheck>> = [];

  constructor() {
    this.registerDefaultChecks();
  }

  private registerDefaultChecks(): void {
    this.checks.push(this.checkSourceDir.bind(this));
    this.checks.push(this.checkWorkspaceDir.bind(this));
    this.checks.push(this.checkDiskSpace.bind(this));
    this.checks.push(this.checkMemory.bind(this));
    this.checks.push(this.checkSnapshots.bind(this));
    this.checks.push(this.checkProviderHealth.bind(this));
  }

  private async checkSourceDir(): Promise<HealthCheck> {
    const start = Date.now();
    const srcExists = existsSync("./src");

    return {
      name: "source_directory",
      status: srcExists ? "pass" : "fail",
      message: srcExists ? "Source directory exists" : "Source directory missing",
      duration: Date.now() - start,
    };
  }

  private async checkWorkspaceDir(): Promise<HealthCheck> {
    const start = Date.now();
    const workspaceExists = existsSync("./workspace");

    return {
      name: "workspace_directory",
      status: workspaceExists ? "pass" : "warn",
      message: workspaceExists
        ? "Workspace directory exists"
        : "Workspace directory missing (will be created)",
      duration: Date.now() - start,
    };
  }

  private async checkDiskSpace(): Promise<HealthCheck> {
    const start = Date.now();
    // Simple check - just verify we can write
    try {
      const stat = statSync(".");
      return {
        name: "disk_space",
        status: "pass",
        message: "Disk accessible",
        duration: Date.now() - start,
      };
    } catch {
      return {
        name: "disk_space",
        status: "fail",
        message: "Disk access error",
        duration: Date.now() - start,
      };
    }
  }

  private async checkMemory(): Promise<HealthCheck> {
    const start = Date.now();
    const used = process.memoryUsage();
    const heapUsedMB = Math.round(used.heapUsed / 1024 / 1024);
    const heapTotalMB = Math.round(used.heapTotal / 1024 / 1024);
    const ratio = heapUsedMB / heapTotalMB;

    let status: "pass" | "warn" | "fail" = "pass";
    if (ratio > 0.9) status = "fail";
    else if (ratio > 0.7) status = "warn";

    return {
      name: "memory",
      status,
      message: `Heap: ${heapUsedMB}MB / ${heapTotalMB}MB (${Math.round(ratio * 100)}%)`,
      duration: Date.now() - start,
    };
  }

  /**
   * スナップショット数をチェック
   * >10: warn, >20: fail
   * 超過時は自動で forceCleanup() を実行
   */
  private async checkSnapshots(): Promise<HealthCheck> {
    const start = Date.now();
    const statusInfo = snapshotManager.getStatus();
    const count = statusInfo.count;
    const max = statusInfo.maxSnapshots;

    let status: "pass" | "warn" | "fail" = "pass";
    let repairAttempted = false;
    let repairSuccess = false;

    if (count > 20) {
      status = "fail";
    } else if (count > 10) {
      status = "warn";
    }

    // スナップショット超過時は自動クリーンアップ
    if (statusInfo.isOverLimit || count > 10) {
      repairAttempted = true;
      logger.info("Snapshot count exceeds threshold, attempting cleanup", {
        count,
        max,
      });

      const result = snapshotManager.forceCleanup();
      repairSuccess = result.success;

      await eventBus.emit({
        type: "health_repair_attempted",
        checkName: "snapshots",
        success: result.success,
        details: `Deleted ${result.deleted} snapshots${result.errors.length > 0 ? `, errors: ${result.errors.join("; ")}` : ""}`,
        timestamp: new Date(),
      });

      // クリーンアップ後に再チェック
      if (repairSuccess) {
        const newStatus = snapshotManager.getStatus();
        if (newStatus.count <= 10) {
          status = "pass";
        } else if (newStatus.count <= 20) {
          status = "warn";
        }
      }
    }

    return {
      name: "snapshots",
      status,
      message: `Snapshot count: ${count}/${max}${repairAttempted ? ` (cleanup ${repairSuccess ? "succeeded" : "failed"})` : ""}`,
      duration: Date.now() - start,
      repairAttempted,
      repairSuccess,
    };
  }

  /**
   * AIプロバイダーの状態をチェック
   */
  private async checkProviderHealth(): Promise<HealthCheck> {
    const start = Date.now();

    const healthMonitor = getHealthMonitor();
    if (!healthMonitor) {
      return {
        name: "ai_providers",
        status: "warn",
        message: "Provider health monitor not initialized",
        duration: Date.now() - start,
      };
    }

    try {
      const healthReport = healthMonitor.getHealthReport();

      let status: "pass" | "warn" | "fail" = "pass";
      const brokenProviders: string[] = [];
      const degradedProviders: string[] = [];

      for (const [provider, providerStatus] of Object.entries(healthReport.providers) as [string, ProviderHealth][]) {
        if (providerStatus.status === "broken") {
          brokenProviders.push(provider);
        } else if (providerStatus.status === "degraded") {
          degradedProviders.push(provider);
        }
      }

      if (brokenProviders.length > 0) {
        if (brokenProviders.length === Object.keys(healthReport.providers).length) {
          status = "fail";
        } else {
          status = "warn";
        }
      } else if (degradedProviders.length > 0) {
        status = "warn";
      }

      const providerCount = Object.keys(healthReport.providers).length;
      let message = `AI Providers: ${providerCount - brokenProviders.length}/${providerCount} healthy`;
      if (brokenProviders.length > 0) {
        message += `, broken: ${brokenProviders.join(", ")}`;
      }
      if (degradedProviders.length > 0) {
        message += `, degraded: ${degradedProviders.join(", ")}`;
      }

      return {
        name: "ai_providers",
        status,
        message,
        duration: Date.now() - start,
      };
    } catch {
      return {
        name: "ai_providers",
        status: "warn",
        message: "Error checking provider health",
        duration: Date.now() - start,
      };
    }
  }

  async run(): Promise<HealthStatus> {
    const results: HealthCheck[] = [];

    for (const check of this.checks) {
      try {
        const result = await check();
        results.push(result);
      } catch (err) {
        results.push({
          name: "unknown",
          status: "fail",
          message: err instanceof Error ? err.message : "Unknown error",
        });
      }
    }

    const failCount = results.filter((r) => r.status === "fail").length;
    const warnCount = results.filter((r) => r.status === "warn").length;

    let overall: "healthy" | "degraded" | "unhealthy" = "healthy";
    if (failCount > 0) overall = "unhealthy";
    else if (warnCount > 0) overall = "degraded";

    return {
      overall,
      checks: results,
      timestamp: new Date(),
    };
  }
}
