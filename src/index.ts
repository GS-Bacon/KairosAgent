import { logger } from "./core/logger.js";
import { scheduler } from "./core/scheduler.js";
import { orchestrator } from "./core/orchestrator.js";
import { dailyReporter } from "./core/daily-reporter.js";
import { APIServer } from "./api/server.js";
import { initializeAI, AIConfig } from "./ai/factory.js";
import { guard } from "./safety/guard.js";
import { goalManager } from "./goals/index.js";
import { existsSync, readFileSync, mkdirSync } from "fs";

interface GitConfig {
  autoPush: boolean;
  pushRemote: string;
  allowProtectedBranchPush: boolean;
}

interface DocsConfig {
  enabled: boolean;
  updateFrequency: "every-cycle" | "daily" | "weekly";
  targets: Array<{
    path: string;
    sections: string[];
  }>;
}

interface RateLimitFallbackConfig {
  enabled: boolean;
  fallbackProvider: "glm";
  trackChanges: boolean;
  autoReview: boolean;
  reviewOnPhases: string[];
}

interface ResearchConfig {
  enabled: boolean;
  frequency: number;          // N回に1回実行（デフォルト: 5）
  maxTopicsPerCycle: number;  // 1回のResearchで調査する最大トピック数
  minConfidenceToQueue: number; // キュー登録の最小信頼度（デフォルト: 0.6）
}

interface KairosConfig {
  port: number;
  checkInterval: number;
  ai: AIConfig;
  git: GitConfig;
  docs: DocsConfig;
  rateLimitFallback: RateLimitFallbackConfig;
  research: ResearchConfig;
}

const DEFAULT_CONFIG: KairosConfig = {
  port: 3100,
  checkInterval: 5 * 60 * 1000, // 5 minutes
  ai: {
    provider: "claude",
  },
  git: {
    autoPush: true,
    pushRemote: "origin",
    allowProtectedBranchPush: false,
  },
  docs: {
    enabled: true,
    updateFrequency: "every-cycle",
    targets: [
      {
        path: "./README.md",
        sections: ["LEARNING_STATS", "SYSTEM_STATUS"],
      },
    ],
  },
  rateLimitFallback: {
    enabled: true,
    fallbackProvider: "glm",
    trackChanges: true,
    autoReview: true,
    reviewOnPhases: ["plan", "implement"],
  },
  research: {
    enabled: true,
    frequency: 5,
    maxTopicsPerCycle: 2,
    minConfidenceToQueue: 0.6,
  },
};

let globalConfig: KairosConfig = DEFAULT_CONFIG;

function loadConfig(): KairosConfig {
  const configPath = "./config.json";
  if (existsSync(configPath)) {
    try {
      const content = readFileSync(configPath, "utf-8");
      const loaded = JSON.parse(content);
      globalConfig = {
        ...DEFAULT_CONFIG,
        ...loaded,
        git: { ...DEFAULT_CONFIG.git, ...loaded.git },
        docs: { ...DEFAULT_CONFIG.docs, ...loaded.docs },
        rateLimitFallback: { ...DEFAULT_CONFIG.rateLimitFallback, ...loaded.rateLimitFallback },
        research: { ...DEFAULT_CONFIG.research, ...loaded.research },
      };
      return globalConfig;
    } catch (err) {
      logger.warn("Failed to load config.json, using defaults");
    }
  }
  globalConfig = DEFAULT_CONFIG;
  return DEFAULT_CONFIG;
}

export function getConfig(): KairosConfig {
  return globalConfig;
}

export type { KairosConfig, GitConfig, DocsConfig, RateLimitFallbackConfig, ResearchConfig };

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
    process.exit(0);
  };

  process.on("SIGINT", () => shutdown("SIGINT"));
  process.on("SIGTERM", () => shutdown("SIGTERM"));

  logger.info("KairosAgent is running");
}

main().catch((err) => {
  logger.error("Fatal error", { error: err instanceof Error ? err.message : String(err) });
  process.exit(1);
});
