import { Router, Request, Response } from "express";
import { orchestrator } from "../core/orchestrator.js";
import { scheduler } from "../core/scheduler.js";
import { eventBus, MoltBotEvent } from "../core/event-bus.js";
import { HealthChecker } from "../phases/1-health-check/index.js";
import { snapshotManager } from "../safety/snapshot.js";
import { rollbackManager } from "../safety/rollback.js";
import { guard } from "../safety/guard.js";
import { existsSync, readFileSync, readdirSync } from "fs";
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

eventBus.onAll((event: MoltBotEvent) => {
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
    const context = await orchestrator.runCycle();
    const response: TriggerResponse = {
      success: true,
      message: `Repair cycle completed. Issues: ${context.issues.length}, Improvements: ${context.improvements.length}`,
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

  const subscription = eventBus.onAll((event: MoltBotEvent) => {
    res.write(`event: ${event.type}\n`);
    res.write(`data: ${JSON.stringify(event)}\n\n`);
  });

  req.on("close", () => {
    subscription.unsubscribe();
  });
});

export { router };
