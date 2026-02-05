import { existsSync, readFileSync, writeFileSync } from "fs";
import { Tool, ToolUsageRecord, ToolData, ToolRecommendation } from "./types.js";
import { logger } from "../core/logger.js";

const TOOLS_FILE = "./workspace/tools.json";

const PROFICIENCY_THRESHOLDS = {
  novice: 0,
  intermediate: 5,
  proficient: 20,
  expert: 50,
};

export class ToolTracker {
  private data: ToolData;

  constructor() {
    this.data = this.load();
  }

  private load(): ToolData {
    if (existsSync(TOOLS_FILE)) {
      try {
        const content = readFileSync(TOOLS_FILE, "utf-8");
        return JSON.parse(content);
      } catch (err) {
        logger.error("Failed to load tools data", { error: String(err) });
      }
    }
    return { tools: [], usageHistory: [] };
  }

  private save(): void {
    writeFileSync(TOOLS_FILE, JSON.stringify(this.data, null, 2));
  }

  registerTool(params: {
    name: string;
    description: string;
    category: Tool["category"];
    command: string;
    installCommand?: string;
  }): Tool {
    const existingTool = this.data.tools.find((t) => t.name === params.name);
    if (existingTool) {
      logger.debug("Tool already registered", { name: params.name });
      return existingTool;
    }

    const tool: Tool = {
      id: `tool_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`,
      name: params.name,
      description: params.description,
      category: params.category,
      command: params.command,
      installCommand: params.installCommand,
      usageCount: 0,
      proficiency: "novice",
      addedAt: new Date().toISOString(),
    };

    this.data.tools.push(tool);
    this.save();
    logger.info("Tool registered", { toolId: tool.id, name: tool.name });

    return tool;
  }

  recordUsage(
    toolId: string,
    success: boolean,
    duration?: number,
    context?: string
  ): void {
    const tool = this.getTool(toolId);
    if (!tool) {
      logger.warn("Tool not found for usage recording", { toolId });
      return;
    }

    const record: ToolUsageRecord = {
      toolId,
      timestamp: new Date().toISOString(),
      success,
      duration,
      context,
    };

    this.data.usageHistory.push(record);

    // Update tool usage count and proficiency
    tool.usageCount += 1;
    tool.lastUsed = record.timestamp;
    tool.proficiency = this.calculateProficiency(tool.usageCount);

    this.save();
    logger.debug("Tool usage recorded", { toolId, success, proficiency: tool.proficiency });
  }

  private calculateProficiency(usageCount: number): Tool["proficiency"] {
    if (usageCount >= PROFICIENCY_THRESHOLDS.expert) return "expert";
    if (usageCount >= PROFICIENCY_THRESHOLDS.proficient) return "proficient";
    if (usageCount >= PROFICIENCY_THRESHOLDS.intermediate) return "intermediate";
    return "novice";
  }

  getTool(id: string): Tool | undefined {
    return this.data.tools.find((t) => t.id === id);
  }

  getToolByName(name: string): Tool | undefined {
    return this.data.tools.find((t) => t.name === name);
  }

  getAllTools(): Tool[] {
    return [...this.data.tools];
  }

  getToolsByCategory(category: Tool["category"]): Tool[] {
    return this.data.tools.filter((t) => t.category === category);
  }

  getUsageHistory(toolId?: string): ToolUsageRecord[] {
    if (toolId) {
      return this.data.usageHistory.filter((r) => r.toolId === toolId);
    }
    return [...this.data.usageHistory];
  }

  suggestTools(): ToolRecommendation[] {
    const suggestions: ToolRecommendation[] = [];

    // Check for missing common tools
    const commonTools = [
      {
        name: "eslint",
        category: "linting" as const,
        reason: "Code linting and style enforcement",
        installCommand: "npm install -D eslint",
      },
      {
        name: "prettier",
        category: "formatting" as const,
        reason: "Code formatting",
        installCommand: "npm install -D prettier",
      },
      {
        name: "vitest",
        category: "testing" as const,
        reason: "Fast unit testing",
        installCommand: "npm install -D vitest",
      },
      {
        name: "typescript",
        category: "analysis" as const,
        reason: "Type checking",
        installCommand: "npm install -D typescript",
      },
    ];

    for (const tool of commonTools) {
      const existing = this.data.tools.find((t) => t.name === tool.name);
      if (!existing) {
        suggestions.push({
          toolName: tool.name,
          reason: tool.reason,
          category: tool.category,
          priority: "medium",
          installCommand: tool.installCommand,
        });
      }
    }

    return suggestions;
  }

  initializeDefaultTools(): void {
    const defaults = [
      {
        name: "npm",
        description: "Node.js package manager",
        category: "building" as const,
        command: "npm",
      },
      {
        name: "tsc",
        description: "TypeScript compiler",
        category: "building" as const,
        command: "npx tsc",
      },
    ];

    for (const tool of defaults) {
      this.registerTool(tool);
    }
  }
}

export const toolTracker = new ToolTracker();
