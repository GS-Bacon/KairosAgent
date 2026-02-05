export interface Tool {
  id: string;
  name: string;
  description: string;
  category: "linting" | "testing" | "building" | "formatting" | "analysis" | "other";
  command: string;
  installCommand?: string;
  usageCount: number;
  lastUsed?: string;
  proficiency: "novice" | "intermediate" | "proficient" | "expert";
  addedAt: string;
}

export interface ToolUsageRecord {
  toolId: string;
  timestamp: string;
  success: boolean;
  duration?: number;
  context?: string;
}

export interface ToolRecommendation {
  toolName: string;
  reason: string;
  category: Tool["category"];
  priority: "low" | "medium" | "high";
  installCommand?: string;
}

export interface ToolData {
  tools: Tool[];
  usageHistory: ToolUsageRecord[];
}
