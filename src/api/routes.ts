import { Router, Request, Response } from "express";
import { orchestrator } from "../core/orchestrator.js";
import { scheduler } from "../core/scheduler.js";
import { eventBus, KairosEvent } from "../core/event-bus.js";
import { HealthChecker } from "../phases/1-health-check/index.js";
import { snapshotManager } from "../safety/snapshot.js";
import { rollbackManager } from "../safety/rollback.js";
import { guard } from "../safety/guard.js";
import { existsSync, readFileSync, readdirSync } from "fs";
import { goalManager } from "../goals/index.js";
import { join } from "path";
import {
  StatusResponse,
  HealthResponse,
  TriggerResponse,
  ConfigResponse,
} from "./types.js";

const router = Router();
const startTime = Date.now();
const healthChecker = new HealthChecker();

const history: Array<{
  id: string;
  timestamp: string;
  type: string;
  description: string;
  files?: string[];
}> = [];

eventBus.onAll((event: KairosEvent) => {
  if (event.type === "modification") {
    history.push({
      id: `hist_${Date.now()}`,
      timestamp: new Date().toISOString(),
      type: "modification",
      description: event.description,
      files: [event.file],
    });
  } else if (event.type === "rollback") {
    history.push({
      id: `hist_${Date.now()}`,
      timestamp: new Date().toISOString(),
      type: "rollback",
      description: event.reason,
    });
  } else if (event.type === "error") {
    history.push({
      id: `hist_${Date.now()}`,
      timestamp: new Date().toISOString(),
      type: "error",
      description: event.error,
    });
  }

  if (history.length > 1000) {
    history.splice(0, history.length - 1000);
  }
});

router.get("/status", (_req: Request, res: Response) => {
  const status = orchestrator.getStatus();
  const now = Date.now();
  const sevenDaysAgo = now - 7 * 24 * 60 * 60 * 1000;

  const recentHistory = history.filter(
    (h) => new Date(h.timestamp).getTime() > sevenDaysAgo
  );

  const response: StatusResponse = {
    state: status.isRunning ? "running" : "idle",
    uptime_seconds: Math.floor((now - startTime) / 1000),
    stats: {
      modifications_7d: recentHistory.filter((h) => h.type === "modification").length,
      rollbacks_7d: recentHistory.filter((h) => h.type === "rollback").length,
      errors_7d: recentHistory.filter((h) => h.type === "error").length,
    },
  };

  res.json(response);
});

router.get("/health", async (_req: Request, res: Response) => {
  const health = await healthChecker.run();

  const response: HealthResponse = {
    status: health.overall,
    checks: health.checks.map((c) => ({
      name: c.name,
      status: c.status,
      message: c.message,
    })),
    timestamp: health.timestamp.toISOString(),
  };

  const httpStatus = health.overall === "unhealthy" ? 503 : 200;
  res.status(httpStatus).json(response);
});

router.get("/logs", (req: Request, res: Response) => {
  const page = parseInt(req.query.page as string) || 1;
  const limit = Math.min(parseInt(req.query.limit as string) || 100, 500);
  const logDir = "./workspace/logs";

  const logs: Array<{ timestamp: string; level: string; message: string }> = [];

  if (existsSync(logDir)) {
    const files = readdirSync(logDir)
      .filter((f) => f.endsWith(".log"))
      .sort()
      .reverse()
      .slice(0, 7);

    for (const file of files) {
      const content = readFileSync(join(logDir, file), "utf-8");
      const lines = content.split("\n").filter((l) => l.trim());

      for (const line of lines) {
        const match = line.match(/\[(.+?)\]\s*\[(\w+)\]\s*(.+)/);
        if (match) {
          logs.push({
            timestamp: match[1],
            level: match[2],
            message: match[3],
          });
        }
      }
    }
  }

  logs.reverse();
  const start = (page - 1) * limit;
  const paginated = logs.slice(start, start + limit);

  res.json({
    page,
    limit,
    total: logs.length,
    data: paginated,
  });
});

router.get("/history", (req: Request, res: Response) => {
  const page = parseInt(req.query.page as string) || 1;
  const limit = Math.min(parseInt(req.query.limit as string) || 50, 200);

  const sorted = [...history].reverse();
  const start = (page - 1) * limit;
  const paginated = sorted.slice(start, start + limit);

  res.json({
    page,
    limit,
    total: history.length,
    data: paginated,
  });
});

router.get("/history/:id", (req: Request, res: Response) => {
  const entry = history.find((h) => h.id === req.params.id);
  if (!entry) {
    res.status(404).json({ error: "Not found" });
    return;
  }
  res.json(entry);
});

router.post("/trigger/check", async (_req: Request, res: Response) => {
  try {
    const context = await orchestrator.runCycle();
    const response: TriggerResponse = {
      success: true,
      message: "Check cycle completed",
      cycleId: context.cycleId,
    };
    res.json(response);
  } catch (err) {
    const response: TriggerResponse = {
      success: false,
      message: err instanceof Error ? err.message : "Unknown error",
    };
    res.status(500).json(response);
  }
});

router.post("/trigger/repair", async (_req: Request, res: Response) => {
  try {
    const result = await orchestrator.runCycle();
    const response: TriggerResponse = {
      success: result.success,
      message: `Repair cycle completed. Success: ${result.success}, Troubles: ${result.troubleCount}${result.shouldRetry ? " (retry scheduled)" : ""}`,
      cycleId: result.cycleId,
    };
    res.json(response);
  } catch (err) {
    const response: TriggerResponse = {
      success: false,
      message: err instanceof Error ? err.message : "Unknown error",
    };
    res.status(500).json(response);
  }
});

router.get("/config", (_req: Request, res: Response) => {
  const guardConfig = guard.getConfig();
  const schedulerStatus = scheduler.getStatus();

  const response: ConfigResponse = {
    ai: {
      provider: "claude",
    },
    scheduler: {
      interval: schedulerStatus.tasks[0]?.interval || 3600000,
    },
    safety: {
      maxFilesPerChange: guardConfig.maxFilesPerChange,
      protectedPatterns: guardConfig.protectedPatterns,
    },
  };

  res.json(response);
});

router.put("/config", (req: Request, res: Response) => {
  const updates = req.body;

  if (updates.safety) {
    const protectedFields = ["protectedPatterns", "allowedExtensions"];
    const attemptedProtectedChanges = protectedFields.filter(
      (field) => field in updates.safety
    );

    if (attemptedProtectedChanges.length > 0) {
      res.status(403).json({
        error: "Forbidden",
        message: `Cannot modify protected fields: ${attemptedProtectedChanges.join(", ")}`,
      });
      return;
    }

    guard.updateConfig(updates.safety);
  }

  res.json({ success: true, message: "Configuration updated" });
});

router.get("/snapshots", (_req: Request, res: Response) => {
  const snapshots = snapshotManager.list();
  res.json(snapshots);
});

router.get("/rollbacks", (_req: Request, res: Response) => {
  const rollbacks = rollbackManager.getHistory();
  res.json(rollbacks);
});

router.get("/events", (req: Request, res: Response) => {
  res.setHeader("Content-Type", "text/event-stream");
  res.setHeader("Cache-Control", "no-cache");
  res.setHeader("Connection", "keep-alive");

  res.write("event: connected\n");
  res.write(`data: {"timestamp":"${new Date().toISOString()}"}\n\n`);

  const subscription = eventBus.onAll((event: KairosEvent) => {
    res.write(`event: ${event.type}\n`);
    res.write(`data: ${JSON.stringify(event)}\n\n`);
  });

  req.on("close", () => {
    subscription.unsubscribe();
  });
});

router.get("/goals", (_req: Request, res: Response) => {
  const goals = goalManager.getAllGoals();
  res.json(goals);
});

router.get("/goals/active", (_req: Request, res: Response) => {
  const goals = goalManager.getActiveGoals();
  res.json(goals);
});

router.get("/goals/:id", (req: Request, res: Response) => {
  const goal = goalManager.getGoal(req.params.id);
  if (!goal) {
    res.status(404).json({ error: "Goal not found" });
    return;
  }
  res.json(goal);
});

router.get("/goals/:id/progress", (req: Request, res: Response) => {
  const progress = goalManager.getProgressHistory(req.params.id);
  res.json(progress);
});

router.post("/goals", (req: Request, res: Response) => {
  const { type, title, description, metrics } = req.body;

  if (!type || !title || !description || !metrics) {
    res.status(400).json({ error: "Missing required fields: type, title, description, metrics" });
    return;
  }

  if (type !== "permanent" && type !== "one-time") {
    res.status(400).json({ error: "type must be 'permanent' or 'one-time'" });
    return;
  }

  const goal = goalManager.createGoal({ type, title, description, metrics });
  res.status(201).json(goal);
});

router.post("/goals/:id/deactivate", (req: Request, res: Response) => {
  const goal = goalManager.getGoal(req.params.id);
  if (!goal) {
    res.status(404).json({ error: "Goal not found" });
    return;
  }
  goalManager.deactivateGoal(req.params.id);
  res.json({ success: true, message: "Goal deactivated" });
});

router.post("/goals/:id/reactivate", (req: Request, res: Response) => {
  const goal = goalManager.getGoal(req.params.id);
  if (!goal) {
    res.status(404).json({ error: "Goal not found" });
    return;
  }
  goalManager.reactivateGoal(req.params.id);
  res.json({ success: true, message: "Goal reactivated" });
});

// AI Security Review Stats
router.get("/security/review-stats", (_req: Request, res: Response) => {
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

export { router };
