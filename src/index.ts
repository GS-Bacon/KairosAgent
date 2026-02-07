import { logger } from "./core/logger.js";
import { scheduler } from "./core/scheduler.js";
import { orchestrator } from "./core/orchestrator.js";
import { dailyReporter } from "./core/daily-reporter.js";
import { APIServer } from "./api/server.js";
import { initializeAI } from "./ai/factory.js";
import { guard } from "./safety/guard.js";
import { goalManager } from "./goals/index.js";
import { existsSync, mkdirSync } from "fs";
import { loadConfig } from "./config/config.js";
import type { CycleResult, CycleContext } from "./phases/types.js";

function ensureDirectories(): void {
  const dirs = ["./workspace", "./workspace/logs", "./workspace/history", "./workspace/snapshots"];
  for (const dir of dirs) {
    if (!existsSync(dir)) {
      mkdirSync(dir, { recursive: true });
    }
  }
}

async function main(): Promise<void> {
  logger.info("KairosAgent starting...");

  ensureDirectories();

  // Initialize default goals
  goalManager.initializeDefaultGoals();
  logger.info("Default goals initialized");

  const config = loadConfig();
  logger.info("Configuration loaded", { port: config.port, checkInterval: config.checkInterval });

  // Initialize AI provider
  try {
    await initializeAI(config.ai);
    logger.info("AI provider initialized");
  } catch (err) {
    logger.warn("AI provider initialization failed, will retry on use", {
      error: err instanceof Error ? err.message : String(err),
    });
  }

  // Initialize Guard AI providers for security review
  try {
    guard.initializeAIProviders();
    logger.info("Guard AI providers initialized");
  } catch (err) {
    logger.warn("Guard AI providers initialization failed", {
      error: err instanceof Error ? err.message : String(err),
    });
  }

  // --once mode: run a single cycle, print report, exit
  const onceMode = process.argv.includes("--once");
  if (onceMode) {
    logger.info("Running in --once mode: single cycle execution");
    const result = await orchestrator.runCycle();
    const context = orchestrator.getLastCycleContext();
    printCycleReport(result, context);
    process.exit(result.success ? 0 : 1);
  }

  // Start API server
  const server = new APIServer({ port: config.port });
  await server.start();

  // Register improvement cycle as scheduled task
  scheduler.register(
    "improvement-cycle",
    "Self-Improvement Cycle",
    config.checkInterval,
    async () => {
      try {
        return await orchestrator.runCycle();
      } catch (err) {
        logger.error("Cycle failed", {
          error: err instanceof Error ? err.message : String(err),
        });
        return undefined;
      }
    }
  );

  // Register daily report task (run at 23:55 daily)
  // Calculate interval to run at 23:55 every day
  const calculateTimeUntil2355 = (): number => {
    const now = new Date();
    const target = new Date(now);
    target.setHours(23, 55, 0, 0);
    if (target.getTime() <= now.getTime()) {
      // Already past 23:55 today, schedule for tomorrow
      target.setDate(target.getDate() + 1);
    }
    return target.getTime() - now.getTime();
  };

  // Schedule daily report generation
  const scheduleDailyReport = (): void => {
    const delay = calculateTimeUntil2355();
    setTimeout(async () => {
      try {
        logger.info("Generating daily report");
        await dailyReporter.generate();
      } catch (err) {
        logger.error("Daily report generation failed", {
          error: err instanceof Error ? err.message : String(err),
        });
      }
      // Schedule next day's report
      scheduleDailyReport();
    }, delay);
    logger.info("Daily report scheduled", {
      nextRunIn: `${Math.round(delay / 1000 / 60)} minutes`,
    });
  };

  scheduleDailyReport();

  // Start scheduler
  scheduler.start();

  // Graceful shutdown
  const shutdown = async (signal: string): Promise<void> => {
    logger.info(`Received ${signal}, shutting down...`);
    scheduler.stop();
    await server.stop();
    logger.info("KairosAgent stopped");
    logger.shutdown();
    process.exit(0);
  };

  process.on("SIGINT", () => shutdown("SIGINT"));
  process.on("SIGTERM", () => shutdown("SIGTERM"));

  // 未処理例外ハンドラ
  process.on("unhandledRejection", (reason) => {
    logger.error("Unhandled promise rejection", {
      reason: reason instanceof Error ? reason.message : String(reason),
      stack: reason instanceof Error ? reason.stack : undefined,
    });
  });

  process.on("uncaughtException", (error) => {
    logger.error("Uncaught exception", {
      error: error.message,
      stack: error.stack,
    });
    // 致命的なエラーの場合はgraceful shutdownを試みる
    shutdown("uncaughtException").catch(() => process.exit(1));
  });

  logger.info("KairosAgent is running");
}

function printCycleReport(result: CycleResult, context: CycleContext | null): void {
  const line = "══════════════════════════════════════";
  console.log("");
  console.log(`╔${line}╗`);
  console.log(`║       Improvement Cycle Report       ║`);
  console.log(`╚${line}╝`);
  console.log("");

  // Basic info
  console.log(`  Cycle ID:   ${result.cycleId}`);

  if (result.skippedEarly) {
    console.log(`  Result:     ⏭ SKIPPED (no work detected)`);
    console.log(`  Duration:   ${(result.duration / 1000).toFixed(1)}s`);
    console.log("");
    return;
  }

  if (result.success) {
    console.log(`  Result:     ✅ SUCCESS`);
  } else {
    console.log(`  Result:     ❌ FAILED`);
    if (result.failedPhase) {
      console.log(`  Failed at:  ${result.failedPhase}`);
    }
    if (context?.failureReason) {
      console.log(`  Reason:     ${context.failureReason}`);
    }
  }
  console.log(`  Duration:   ${(result.duration / 1000).toFixed(1)}s`);

  if (!context) {
    console.log("");
    return;
  }

  // Issues
  const sep = "────────────────────────────────────";
  console.log("");
  console.log(`── Issues ${sep}`);
  if (context.issues.length === 0) {
    console.log("  None");
  } else {
    console.log(`  Found: ${context.issues.length} issue(s)`);
    for (const issue of context.issues) {
      console.log(`  • ${issue.id}: ${issue.message}`);
    }
  }

  // Improvements
  console.log("");
  console.log(`── Improvements ${sep}`);
  if (context.improvements.length === 0) {
    console.log("  None");
  } else {
    console.log(`  Found: ${context.improvements.length} improvement(s)`);
    for (const imp of context.improvements) {
      console.log(`  • ${imp.description}`);
    }
  }

  // Changes
  console.log("");
  console.log(`── Changes ${sep}`);
  if (!context.implementedChanges || context.implementedChanges.length === 0) {
    console.log("  None");
  } else {
    console.log(`  Modified: ${context.implementedChanges.length} file(s)`);
    for (const change of context.implementedChanges) {
      console.log(`  • ${change.file} (${change.changeType})`);
    }
  }

  // Tests
  console.log("");
  console.log(`── Tests ${sep}`);
  if (!context.testResults) {
    console.log("  Not executed");
  } else {
    const tr = context.testResults;
    const icon = tr.passed ? "✅" : "❌";
    console.log(`  ${icon} Passed: ${tr.passedTests}/${tr.totalTests} (${tr.failedTests} failed)`);
    if (tr.errors.length > 0) {
      for (const err of tr.errors.slice(0, 5)) {
        console.log(`  • ${err}`);
      }
    }
  }

  // Token Usage
  console.log("");
  console.log(`── Token Usage ${sep}`);
  if (!context.tokenUsage) {
    console.log("  Not tracked");
  } else {
    console.log(`  Input:  ${context.tokenUsage.totalInput.toLocaleString()} tokens`);
    console.log(`  Output: ${context.tokenUsage.totalOutput.toLocaleString()} tokens`);
  }

  // Troubles
  console.log("");
  console.log(`── Troubles ${sep}`);
  if (!context.troubles || context.troubles.length === 0) {
    console.log("  None");
  } else {
    console.log(`  Count: ${context.troubles.length}`);
    for (const t of context.troubles.slice(0, 5)) {
      console.log(`  • [${t.severity}] ${t.message}`);
    }
  }

  console.log("");
}

main().catch((err) => {
  logger.error("Fatal error", { error: err instanceof Error ? err.message : String(err) });
  process.exit(1);
});
