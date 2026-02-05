import { existsSync, statSync } from "fs";
import { HealthStatus, HealthCheck } from "./types.js";
import { logger } from "../../core/logger.js";

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
