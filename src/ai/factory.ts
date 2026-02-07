import { AIProvider } from "./provider.js";
import { ClaudeProvider } from "./claude-provider.js";
import { GLMProvider } from "./glm-provider.js";
import { OpenCodeProvider } from "./opencode-provider.js";
import { HybridProvider } from "./hybrid-provider.js";
import { ResilientAIProvider } from "./resilient-provider.js";
import { logger } from "../core/logger.js";
import type { AIConfig } from "../config/config.js";

export type { AIConfig };

let currentProvider: AIProvider | null = null;

export function createAIProvider(config: AIConfig): AIProvider {
  switch (config.provider) {
    case "claude":
      logger.info("Creating Claude provider", { model: config.claude?.model || "default" });
      return new ClaudeProvider(config.claude);

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

export function setGlobalProvider(provider: AIProvider, glmApiKey?: string): void {
  // ResilientProviderでラップ（GLM APIキーがあれば）
  if (glmApiKey && !(provider instanceof ResilientAIProvider)) {
    currentProvider = new ResilientAIProvider(provider, glmApiKey);
    logger.info(`Set global AI provider with resilient wrapper: ${provider.name}`);
  } else {
    currentProvider = provider;
    logger.info(`Set global AI provider: ${provider.name}`);
  }
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

  // resilientがfalse以外ならResilientProviderでラップ
  const useResilient = config.resilient !== false;
  const glmApiKey = config.glm?.apiKey;

  if (useResilient && glmApiKey) {
    setGlobalProvider(provider, glmApiKey);
  } else {
    setGlobalProvider(provider);
  }

  return getAIProvider();
}
