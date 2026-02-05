import { AIProvider } from "./provider.js";
import { ClaudeProvider } from "./claude-provider.js";
import { GLMProvider } from "./glm-provider.js";
import { OpenCodeProvider } from "./opencode-provider.js";
import { HybridProvider } from "./hybrid-provider.js";
import { logger } from "../core/logger.js";

export interface AIConfig {
  provider: "claude" | "glm" | "opencode" | "hybrid";
  claude?: {
    model?: string;
  };
  glm?: {
    apiKey: string;
    baseUrl?: string;
    model?: string;
  };
}

let currentProvider: AIProvider | null = null;

export function createAIProvider(config: AIConfig): AIProvider {
  switch (config.provider) {
    case "claude":
      logger.info("Creating Claude provider");
      return new ClaudeProvider();

    case "glm":
      if (!config.glm?.apiKey) {
        throw new Error("GLM API key required");
      }
      logger.info("Creating GLM provider");
      return new GLMProvider(config.glm);

    case "opencode":
      logger.info("Creating OpenCode provider");
      return new OpenCodeProvider();

    case "hybrid":
      logger.info("Creating Hybrid provider (Claude + OpenCode)");
      return new HybridProvider();

    default:
      throw new Error(`Unknown provider: ${config.provider}`);
  }
}

export function setGlobalProvider(provider: AIProvider): void {
  currentProvider = provider;
  logger.info(`Set global AI provider: ${provider.name}`);
}

export function getAIProvider(): AIProvider {
  if (!currentProvider) {
    throw new Error("AI provider not initialized. Call setGlobalProvider first.");
  }
  return currentProvider;
}

export async function initializeAI(config: AIConfig): Promise<AIProvider> {
  const provider = createAIProvider(config);

  const available = await provider.isAvailable();
  if (!available) {
    throw new Error(`AI provider ${provider.name} is not available`);
  }

  setGlobalProvider(provider);
  return provider;
}
