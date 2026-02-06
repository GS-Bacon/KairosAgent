/**
 * API Router - Route Aggregator
 *
 * 各コントローラにルーティングを委譲
 * このファイルはルート登録のみ（ビジネスロジックなし）
 */

import { Router, Request, Response } from "express";
import { orchestrator } from "../core/orchestrator.js";
import { HealthChecker } from "../phases/1-health-check/index.js";
import {
  StatusResponse,
  HealthResponse,
  TriggerResponse,
  CriticalAlertInfo,
  ProviderHealthInfo,
} from "./types.js";
import { getHealthMonitor } from "../ai/provider-health.js";
import { criticalAlertManager } from "../notifications/critical-alert.js";
import { API, PAGINATION } from "../config/constants.js";

// Controllers
import { cycleRouter } from "./controllers/cycle-controller.js";
import { queueRouter } from "./controllers/queue-controller.js";
import { goalRouter } from "./controllers/goal-controller.js";
import { configRouter } from "./controllers/config-controller.js";
import { logRouter } from "./controllers/log-controller.js";
import { snapshotRouter } from "./controllers/snapshot-controller.js";
import { eventRouter, getHistory } from "./controllers/event-controller.js";

const router = Router();
const startTime = Date.now();
const healthChecker = new HealthChecker();

// ========================================
// Core APIs (status, health, trigger)
// ========================================

router.get("/status", (_req: Request, res: Response) => {
  const status = orchestrator.getStatus();
  const now = Date.now();
  const thirtyDaysAgo = now - API.STATS_DAYS * 24 * 60 * 60 * 1000;
  const history = getHistory();

  const recentHistory = history.filter(
    (h) => new Date(h.timestamp).getTime() > thirtyDaysAgo
  );

  const healthMonitor = getHealthMonitor();
  const activeAlerts = criticalAlertManager.getActiveAlerts();

  const criticalAlerts: CriticalAlertInfo[] = activeAlerts.map((alert) => ({
    type: alert.alertType,
    message: alert.message,
    timestamp: alert.timestamp.toISOString(),
    affectedProviders: alert.affectedProviders,
  }));

  const providerHealth: ProviderHealthInfo[] = healthMonitor
    ? healthMonitor.getAllHealth().map((h) => ({
        name: h.name,
        status: h.status,
        consecutiveFailures: h.consecutiveFailures,
        lastSuccess: h.lastSuccess?.toISOString(),
        lastFailure: h.lastFailure?.toISOString(),
      }))
    : [];

  const hasCriticalAlerts = criticalAlerts.length > 0;

  const response: StatusResponse = {
    state: hasCriticalAlerts ? "critical" : status.isRunning ? "running" : "idle",
    uptime_seconds: Math.floor((now - startTime) / 1000),
    stats: {
      modifications_30d: recentHistory.filter((h) => h.type === "modification").length,
      rollbacks_30d: recentHistory.filter((h) => h.type === "rollback").length,
      errors_30d: recentHistory.filter((h) => h.type === "error").length,
    },
    criticalAlerts: criticalAlerts.length > 0 ? criticalAlerts : undefined,
    providerHealth: providerHealth.length > 0 ? providerHealth : undefined,
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

router.get("/history", (req: Request, res: Response) => {
  const page = parseInt(req.query.page as string) || 1;
  const limit = Math.min(parseInt(req.query.limit as string) || PAGINATION.HISTORY_DEFAULT, PAGINATION.HISTORY_MAX);
  const history = getHistory();

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
  const history = getHistory();
  const entry = history.find((h) => h.id === req.params.id);
  if (!entry) {
    res.status(404).json({ error: "Not found" });
    return;
  }
  res.json(entry);
});

// ========================================
// Trigger APIs
// ========================================

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

router.post("/trigger/research", async (_req: Request, res: Response) => {
  try {
    const result = await orchestrator.runResearchCycle();
    res.json(result);
  } catch (err) {
    res.status(500).json({
      success: false,
      message: err instanceof Error ? err.message : "Unknown error",
    });
  }
});

// ========================================
// Delegate to Controllers
// ========================================

router.use("/config", configRouter);
router.use("/security", configRouter);
router.use("/logs", logRouter);
router.use("/goals", goalRouter);
router.use("/cycles", cycleRouter);
router.use("/queues", queueRouter);
router.use("/events", eventRouter);
router.use("/", snapshotRouter);

export { router };
