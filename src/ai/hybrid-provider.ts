import {
  AIProvider,
  CodeContext,
  TestContext,
  Analysis,
  SearchResult,
} from "./provider.js";
import { ClaudeProvider } from "./claude-provider.js";
import { OpenCodeProvider } from "./opencode-provider.js";
import { logger } from "../core/logger.js";

export type PhaseName =
  | "health-check"
  | "error-detect"
  | "improve-find"
  | "search"
  | "plan"
  | "implement"
  | "test-gen"
  | "verify";

const PHASE_PROVIDER_MAP: Record<PhaseName, "claude" | "opencode"> = {
  "health-check": "opencode",
  "error-detect": "opencode",
  "improve-find": "opencode",
  "search": "opencode",
  "plan": "claude",
  "implement": "claude",
  "test-gen": "opencode",
  "verify": "opencode",
};

export class HybridProvider implements AIProvider {
  name = "hybrid";
  private claudeProvider: ClaudeProvider;
  private openCodeProvider: OpenCodeProvider;
  private currentPhase: PhaseName = "health-check";
  private openCodeAvailable: boolean = false;

  constructor() {
    this.claudeProvider = new ClaudeProvider();
    this.openCodeProvider = new OpenCodeProvider();
  }

  setCurrentPhase(phase: PhaseName): void {
    this.currentPhase = phase;
    logger.debug("Hybrid provider phase set", {
      phase,
      provider: PHASE_PROVIDER_MAP[phase],
    });
  }

  getCurrentPhase(): PhaseName {
    return this.currentPhase;
  }

  private getProviderForPhase(): AIProvider {
    const providerType = PHASE_PROVIDER_MAP[this.currentPhase];

    if (providerType === "opencode" && this.openCodeAvailable) {
      logger.debug("Using OpenCode provider", { phase: this.currentPhase });
      return this.openCodeProvider;
    }

    logger.debug("Using Claude provider", {
      phase: this.currentPhase,
      reason: providerType === "opencode" ? "opencode unavailable" : "phase requires claude",
    });
    return this.claudeProvider;
  }

  async generateCode(prompt: string, context: CodeContext): Promise<string> {
    return this.getProviderForPhase().generateCode(prompt, context);
  }

  async generateTest(code: string, context: TestContext): Promise<string> {
    return this.getProviderForPhase().generateTest(code, context);
  }

  async analyzeCode(code: string): Promise<Analysis> {
    return this.getProviderForPhase().analyzeCode(code);
  }

  async searchAndAnalyze(query: string, codebase: string[]): Promise<SearchResult> {
    return this.getProviderForPhase().searchAndAnalyze(query, codebase);
  }

  async chat(prompt: string): Promise<string> {
    return this.getProviderForPhase().chat(prompt);
  }

  async isAvailable(): Promise<boolean> {
    const claudeAvailable = await this.claudeProvider.isAvailable();
    this.openCodeAvailable = await this.openCodeProvider.isAvailable();

    logger.info("Hybrid provider availability check", {
      claude: claudeAvailable,
      opencode: this.openCodeAvailable,
    });

    return claudeAvailable;
  }
}
