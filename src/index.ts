import { logger } from "./core/logger.js";
import { scheduler } from "./core/scheduler.js";
import { orchestrator } from "./core/orchestrator.js";
import { APIServer } from "./api/server.js";
import { initializeAI, AIConfig } from "./ai/factory.js";
import { guard } from "./safety/guard.js";
import { existsSync, readFileSync, mkdirSync } from "fs";

interface KairosConfig {
  port: number;
  checkInterval: number;
  ai: AIConfig;
}

const DEFAULT_CONFIG: KairosConfig = {
  port: 3100,
  checkInterval: 30 * 60 * 1000, // 30 minutes
  ai: {
    provider: "claude",
  },
};

function loadConfig(): KairosConfig {
  const configPath = "./config.json";
  if (existsSync(configPath)) {
    try {
      const content = readFileSync(configPath, "utf-8");
      const loaded = JSON.parse(content);
      return { ...DEFAULT_CONFIG, ...loaded };
    } catch (err) {
      logger.warn("Failed to load config.json, using defaults");
    }
  }
  return DEFAULT_CONFIG;
}

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
        await orchestrator.runCycle();
      } catch (err) {
        logger.error("Cycle failed", {
          error: err instanceof Error ? err.message : String(err),
        });
      }
    }
  );

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
