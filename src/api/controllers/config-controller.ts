import { Router, Request, Response } from "express";
import { scheduler } from "../../core/scheduler.js";
import { guard } from "../../safety/guard.js";
import { ConfigResponse } from "../types.js";
import { SCHEDULING, RETRY } from "../../config/constants.js";

const configRouter = Router();

configRouter.get("/", (_req: Request, res: Response) => {
  const guardConfig = guard.getConfig();
  const schedulerStatus = scheduler.getStatus();

  const response: ConfigResponse = {
    ai: {
      provider: "claude",
    },
    scheduler: {
      interval: schedulerStatus.tasks[0]?.interval || SCHEDULING.DEFAULT_CYCLE_INTERVAL_MS,
      maxRetries: schedulerStatus.retryState?.maxRetries || RETRY.MAX_RETRIES,
      retryState: schedulerStatus.retryState,
    },
    safety: {
      maxFilesPerChange: guardConfig.maxFilesPerChange,
      protectedPatterns: guardConfig.protectedPatterns,
    },
  };

  res.json(response);
});

configRouter.put("/", (req: Request, res: Response) => {
  const updates = req.body;

  if (!updates || typeof updates !== "object") {
    res.status(400).json({ error: "Invalid configuration" });
    return;
  }

  // セキュリティ上、保護フィールドはAPI経由で変更不可
  const protectedFields = [
    "protectedPatterns",
    "allowedExtensions",
    "aiReviewEnabled",
    "strictlyProtectedPatterns",
    "conditionallyProtectedPatterns",
  ];
  for (const field of protectedFields) {
    if (field in updates) {
      res.status(403).json({
        error: `Cannot modify '${field}' via API`,
      });
      return;
    }
  }

  guard.updateConfig(updates);
  res.json({ success: true, message: "Configuration updated" });
});

// AI Security Review Stats
configRouter.get("/security/review-stats", (_req: Request, res: Response) => {
  const stats = guard.getReviewStats();
  res.json({
    totalReviews: stats.total,
    openCodeTrustScore: stats.openCodeTrust,
    openCodeReady: stats.openCodeTrust >= 0.8,
    recentReviews: stats.recentReviews.map((r) => ({
      timestamp: r.timestamp,
      warnings: r.warnings,
      claudeApproved: r.claudeVerdict?.approved,
      openCodeApproved: r.openCodeVerdict?.approved,
      finalDecision: r.finalDecision,
    })),
  });
});

export { configRouter };
