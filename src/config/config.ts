import { existsSync, readFileSync } from "fs";
import { logger } from "../core/logger.js";

export interface AIConfig {
  provider: "claude" | "glm" | "opencode" | "hybrid";
  claude?: {
    model?: string;
    planModel?: string;
    timeout?: number;
    idleTimeout?: number;
  };
  glm?: {
    apiKey: string;
    baseUrl?: string;
    model?: string;
  };
  resilient?: boolean;
}

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
  frequency: number;
  maxTopicsPerCycle: number;
  minConfidenceToQueue: number;
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

export function loadConfig(): KairosConfig {
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
