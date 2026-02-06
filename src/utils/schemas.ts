/**
 * Zod Schemas for Persisted Data
 *
 * 全永続化データのzodスキーマ定義
 */

import { z } from "zod";

// ========================================
// Trouble Schemas
// ========================================

export const TroubleCategorySchema = z.enum([
  "build-error", "test-failure", "naming-conflict", "type-error",
  "runtime-error", "lint-error", "dependency-error", "config-error",
  "security-issue", "performance-issue", "other",
]);

export const TroubleSeveritySchema = z.enum(["low", "medium", "high", "critical"]);

export const TroubleSchema = z.object({
  id: z.string(),
  cycleId: z.string(),
  phase: z.string(),
  category: TroubleCategorySchema,
  severity: TroubleSeveritySchema,
  message: z.string(),
  file: z.string().optional(),
  line: z.number().optional(),
  column: z.number().optional(),
  stackTrace: z.string().optional(),
  context: z.record(z.unknown()).optional(),
  resolved: z.boolean(),
  resolvedBy: z.string().optional(),
  occurredAt: z.string(),
  resolvedAt: z.string().optional(),
});

export const TroubleStoreSchema = z.object({
  version: z.number(),
  troubles: z.array(TroubleSchema),
  lastUpdated: z.string(),
});

// ========================================
// Improvement Queue Schemas
// ========================================

export const ImprovementSourceSchema = z.enum([
  "phase-health-check", "phase-error-detect", "phase-improve-find",
  "phase-search", "phase-plan", "phase-implement", "phase-test-gen",
  "phase-verify", "trouble-abstraction", "research", "manual",
]);

export const ImprovementStatusSchema = z.enum([
  "pending", "scheduled", "in_progress", "completed", "failed", "skipped",
]);

export const ImprovementTypeSchema = z.enum([
  "bug-fix", "feature", "refactor", "prevention", "documentation",
  "tooling", "testing", "security", "performance", "research-finding",
  "recommendation",
]);

export const QueuedImprovementSchema = z.object({
  id: z.string(),
  source: ImprovementSourceSchema,
  type: ImprovementTypeSchema,
  title: z.string(),
  description: z.string(),
  priority: z.number().min(0).max(100),
  status: ImprovementStatusSchema,
  metadata: z.record(z.unknown()).optional(),
  relatedFile: z.string().optional(),
  relatedTroubleIds: z.array(z.string()).optional(),
  relatedPatternId: z.string().optional(),
  preventionSuggestionId: z.string().optional(),
  relatedGoalId: z.string().optional(),
  details: z.string().optional(),
  createdAt: z.string(),
  updatedAt: z.string(),
  scheduledFor: z.string().optional(),
  completedAt: z.string().optional(),
  cycleId: z.string().optional(),
  result: z.object({
    success: z.boolean(),
    message: z.string().optional(),
    commitHash: z.string().optional(),
  }).optional(),
});

export const QueueStoreSchema = z.object({
  version: z.number(),
  queue: z.array(QueuedImprovementSchema),
  lastUpdated: z.string(),
});

// ========================================
// Change Tracker Schemas
// ========================================

export const ReviewResultSchema = z.object({
  approved: z.boolean(),
  issues: z.array(z.string()),
  suggestions: z.array(z.string()),
});

export const TrackedChangeSchema = z.object({
  id: z.string(),
  timestamp: z.string(),
  phase: z.string(),
  provider: z.literal("glm"),
  files: z.array(z.string()),
  description: z.string(),
  reviewed: z.boolean(),
  reviewResult: ReviewResultSchema.optional(),
  confirmationStatus: z.enum(["pending", "confirmed", "rejected", "needs_review"]).optional(),
});

export const TrackedChangesArraySchema = z.array(TrackedChangeSchema);

// ========================================
// Confirmation Queue Schemas
// ========================================

export const ConfirmationItemSchema = z.object({
  id: z.string(),
  changeId: z.string(),
  status: z.enum(["pending", "in_review", "confirmed", "rejected", "needs_review"]),
  priority: z.number(),
  createdAt: z.string(),
  reviewedAt: z.string().optional(),
  reviewNotes: z.string().optional(),
});

export const ConfirmationItemsArraySchema = z.array(ConfirmationItemSchema);

// ========================================
// Pattern Schemas
// ========================================

export const PatternStatsSchema = z.object({
  usageCount: z.number(),
  successCount: z.number(),
  confidence: z.number(),
  phase: z.enum(["initial", "maturing", "stable"]),
  lastUsed: z.string(),
});

export const PatternSolutionSchema = z.object({
  type: z.enum(["script", "template", "ai-prompt"]),
  content: z.string(),
});

export const LearnedPatternSchema = z.object({
  id: z.string(),
  name: z.string(),
  version: z.number(),
  conditions: z.array(z.object({
    type: z.enum(["regex", "file-glob", "ast-pattern", "error-code"]),
    value: z.string(),
    target: z.enum(["content", "filename", "error-message"]),
  })),
  solution: PatternSolutionSchema,
  stats: PatternStatsSchema,
  history: z.array(z.object({
    version: z.number(),
    timestamp: z.string(),
    changeReason: z.string(),
  })),
  createdAt: z.string(),
  learnedFrom: z.string().optional(),
}).passthrough();

export const PatternsDataSchema = z.object({
  version: z.number(),
  patterns: z.array(LearnedPatternSchema),
  lastUpdated: z.string(),
});
