import { Router, Request, Response } from "express";
import { orchestrator } from "../core/orchestrator.js";
import { scheduler } from "../core/scheduler.js";
import { eventBus, KairosEvent } from "../core/event-bus.js";
import { HealthChecker } from "../phases/1-health-check/index.js";
import { snapshotManager } from "../safety/snapshot.js";
import { rollbackManager } from "../safety/rollback.js";
import { guard } from "../safety/guard.js";
import { existsSync, readFileSync, readdirSync, statSync } from "fs";
import { goalManager } from "../goals/index.js";
import { join } from "path";
import {
  StatusResponse,
  HealthResponse,
  TriggerResponse,
  ConfigResponse,
  CriticalAlertInfo,
  ProviderHealthInfo,
  MarkdownLogFile,
  MarkdownLogListResponse,
  MarkdownLogContentResponse,
  CycleSummary,
  CycleDetail,
  CycleIssue,
  CycleChange,
  CycleTrouble,
  CycleListResponse,
  CycleDetailResponse,
} from "./types.js";
import { getHealthMonitor } from "../ai/provider-health.js";
import { criticalAlertManager } from "../notifications/critical-alert.js";

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
  const thirtyDaysAgo = now - 30 * 24 * 60 * 60 * 1000;

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

// ログキャッシュ（ファイル変更時のみ再読込）
type LogEntry = { timestamp: string; level: string; message: string };
let logsCache: { entries: LogEntry[]; mtimes: Map<string, number> } | null = null;

function parseLogFiles(logDir: string): { entries: LogEntry[]; mtimes: Map<string, number> } {
  const entries: LogEntry[] = [];
  const mtimes = new Map<string, number>();

  if (!existsSync(logDir)) return { entries, mtimes };

  const files = readdirSync(logDir)
    .filter((f) => f.endsWith(".log"))
    .sort()
    .reverse()
    .slice(0, 7);

  for (const file of files) {
    const filePath = join(logDir, file);
    const stat = statSync(filePath);
    mtimes.set(file, stat.mtimeMs);

    const content = readFileSync(filePath, "utf-8");
    const lines = content.split("\n").filter((l) => l.trim());

    for (const line of lines) {
      const match = line.match(/\[(.+?)\]\s*\[(\w+)\]\s*(.+)/);
      if (match) {
        entries.push({
          timestamp: match[1],
          level: match[2],
          message: match[3],
        });
      }
    }
  }

  return { entries, mtimes };
}

function isCacheValid(logDir: string): boolean {
  if (!logsCache) return false;
  if (!existsSync(logDir)) return logsCache.entries.length === 0;

  const files = readdirSync(logDir)
    .filter((f) => f.endsWith(".log"))
    .sort()
    .reverse()
    .slice(0, 7);

  if (files.length !== logsCache.mtimes.size) return false;

  for (const file of files) {
    const filePath = join(logDir, file);
    const stat = statSync(filePath);
    const cachedMtime = logsCache.mtimes.get(file);
    if (!cachedMtime || cachedMtime !== stat.mtimeMs) return false;
  }

  return true;
}

router.get("/logs", (req: Request, res: Response) => {
  const page = parseInt(req.query.page as string) || 1;
  const limit = Math.min(parseInt(req.query.limit as string) || 100, 500);
  const logDir = "./workspace/logs";

  if (!isCacheValid(logDir)) {
    logsCache = parseLogFiles(logDir);
  }

  const logs = [...logsCache!.entries].reverse();
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

router.get("/config", (_req: Request, res: Response) => {
  const guardConfig = guard.getConfig();
  const schedulerStatus = scheduler.getStatus();

  const response: ConfigResponse = {
    ai: {
      provider: "claude",
    },
    scheduler: {
      interval: schedulerStatus.tasks[0]?.interval || 3600000,
      retryState: schedulerStatus.retryState,
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

router.get("/snapshots", (req: Request, res: Response) => {
  const limit = Math.min(parseInt(req.query.limit as string) || 50, 200);
  const snapshots = snapshotManager.list().slice(0, limit);
  res.json({
    count: snapshots.length,
    data: snapshots,
  });
});

router.get("/rollbacks", (req: Request, res: Response) => {
  const limit = Math.min(parseInt(req.query.limit as string) || 50, 200);
  const rollbacks = rollbackManager.getHistory().slice(0, limit);
  res.json({
    count: rollbacks.length,
    data: rollbacks,
  });
});

// イベント履歴取得（JSON）- SSEとは別に過去イベントを取得
router.get("/events/history", (req: Request, res: Response) => {
  const limit = Math.min(parseInt(req.query.limit as string) || 100, 500);
  const events = history.slice(-limit);
  res.json({
    count: events.length,
    data: events,
  });
});

// SSEストリーミング
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

// Markdown log files API
const MARKDOWN_LOG_DIR = "./workspace/logs";

router.get("/logs/files", (req: Request, res: Response) => {
  const type = (req.query.type as string) || "all";
  const dateFilter = req.query.date as string;

  if (!existsSync(MARKDOWN_LOG_DIR)) {
    const response: MarkdownLogListResponse = { count: 0, data: [] };
    res.json(response);
    return;
  }

  const files = readdirSync(MARKDOWN_LOG_DIR)
    .filter((f) => f.endsWith(".md"))
    .map((filename) => {
      const filePath = join(MARKDOWN_LOG_DIR, filename);
      const stat = statSync(filePath);
      // Parse filename: YYYY-MM-DD-<topic>.md
      const match = filename.match(/^(\d{4}-\d{2}-\d{2})-(.+)\.md$/);
      const date = match ? match[1] : "";
      const topic = match ? match[2] : filename.replace(".md", "");

      return {
        filename,
        date,
        topic,
        path: `/api/logs/files/${encodeURIComponent(filename)}`,
        size: stat.size,
        mtime: stat.mtime.toISOString(),
      } as MarkdownLogFile;
    })
    .filter((f) => {
      if (dateFilter && f.date !== dateFilter) return false;
      if (type === "daily-report" && !f.topic.includes("daily")) return false;
      return true;
    })
    .sort((a, b) => new Date(b.mtime).getTime() - new Date(a.mtime).getTime());

  const response: MarkdownLogListResponse = {
    count: files.length,
    data: files,
  };

  res.json(response);
});

router.get("/logs/files/:filename", (req: Request, res: Response) => {
  const filename = req.params.filename;

  // Path traversal prevention
  if (filename.includes("..") || filename.includes("/") || filename.includes("\\")) {
    res.status(400).json({ error: "Invalid filename" });
    return;
  }

  if (!filename.endsWith(".md")) {
    res.status(400).json({ error: "Only markdown files are allowed" });
    return;
  }

  const filePath = join(MARKDOWN_LOG_DIR, filename);

  // Verify the resolved path is within the log directory
  const resolvedPath = join(process.cwd(), filePath);
  const resolvedLogDir = join(process.cwd(), MARKDOWN_LOG_DIR);
  if (!resolvedPath.startsWith(resolvedLogDir)) {
    res.status(403).json({ error: "Access denied" });
    return;
  }

  if (!existsSync(filePath)) {
    res.status(404).json({ error: "File not found" });
    return;
  }

  const stat = statSync(filePath);
  const content = readFileSync(filePath, "utf-8");

  const response: MarkdownLogContentResponse = {
    filename,
    content,
    size: stat.size,
    mtime: stat.mtime.toISOString(),
  };

  res.json(response);
});

// Cycle logs API
const CYCLE_LOG_PREFIX = "cycle-";
const RESEARCH_LOG_PREFIX = "research-";

/**
 * サイクルタイプを判定（ファイル内容から）
 */
function detectCycleType(filename: string, content: string): "repair" | "research" | "optimize" | "refactor" {
  // ファイル名からタイプを判定
  if (filename.includes("-research-")) {
    return "research";
  }
  // コンテンツからタイプを判定（新形式: **Type**: で始まる行）
  const typeMatch = content.match(/\*\*Type\*\*:\s*🔬\s*Research/);
  if (typeMatch) {
    return "research";
  }
  // デフォルトはrepair
  return "repair";
}

function parseCycleLogSummary(filename: string, content: string): CycleSummary | null {
  // repairログ形式: YYYY-MM-DD-cycle-XXXXXXX.md
  const cycleMatch = filename.match(/^(\d{4}-\d{2}-\d{2})-cycle-(\d+)\.md$/);
  // researchログ形式: YYYY-MM-DD-research-XXXXXXX.md
  const researchMatch = filename.match(/^(\d{4}-\d{2}-\d{2})-research-(\w+)\.md$/);

  if (!cycleMatch && !researchMatch) return null;

  const isResearch = !!researchMatch;
  const match = isResearch ? researchMatch : cycleMatch;
  const date = match![1];
  const cycleId = isResearch ? `research_${match![2]}` : `cycle_${match![2]}`;

  // Parse summary section（新旧両形式をサポート）
  const startTimeMatch = content.match(/\*\*Start(?:\s+Time)?\*\*:\s*(.+)/);
  const endTimeMatch = content.match(/\*\*End(?:\s+Time)?\*\*:\s*(.+)/);
  const durationMatch = content.match(/\*\*Duration\*\*:\s*([\d.]+)\s*seconds/);
  const statusMatch = content.match(/\*\*Status\*\*:\s*(?:✅\s*)?(?:❌\s*)?(Success|Failure)/i);

  // Count issues
  const issuesSection = content.match(/## Issues Detected[\s\S]*?(?=##|$)/);
  const issueLines = issuesSection
    ? (issuesSection[0].match(/^- \[/gm) || []).length
    : 0;

  // Count changes
  const changesSection = content.match(/## Changes Made[\s\S]*?(?=##|$)/);
  const changeLines = changesSection
    ? (changesSection[0].match(/^- /gm) || []).length
    : 0;

  // Count troubles
  const troublesSection = content.match(/## Troubles[\s\S]*?(?=##|$)/);
  const troubleLines = troublesSection
    ? (troublesSection[0].match(/^- /gm) || []).length
    : 0;

  // リサーチ用: findings / approachesをカウント
  let findingsCount = 0;
  let approachesCount = 0;
  if (isResearch) {
    const findingsSection = content.match(/## Findings[\s\S]*?(?=##|$)/);
    findingsCount = findingsSection
      ? (findingsSection[0].match(/^### /gm) || []).length
      : 0;
    const approachesSection = content.match(/## Approaches[\s\S]*?(?=##|$)/);
    approachesCount = approachesSection
      ? (approachesSection[0].match(/^### /gm) || []).length
      : 0;
  }

  const startTime = startTimeMatch ? startTimeMatch[1].trim() : "";
  const endTime = endTimeMatch ? endTimeMatch[1].trim() : undefined;
  const duration = durationMatch ? parseFloat(durationMatch[1]) : 0;
  const success = statusMatch ? statusMatch[1].toLowerCase() === "success" : true;

  const cycleType = detectCycleType(filename, content);

  const summary: CycleSummary = {
    cycleId,
    filename,
    date,
    startTime,
    endTime,
    duration,
    success,
    issueCount: issueLines,
    changeCount: changeLines,
    troubleCount: troubleLines,
    cycleType,
  };

  // リサーチ固有のフィールドを追加
  if (cycleType === "research") {
    (summary as CycleSummary & { findingsCount?: number; approachesCount?: number }).findingsCount = findingsCount;
    (summary as CycleSummary & { findingsCount?: number; approachesCount?: number }).approachesCount = approachesCount;
  }

  return summary;
}

/**
 * リサーチログ（JSON）をパースしてCycleSummaryを生成
 */
function parseResearchLogSummary(filename: string, content: string): CycleSummary | null {
  const match = filename.match(/^(\d{4}-\d{2}-\d{2})-research-(.+)\.json$/);
  if (!match) return null;

  try {
    const data = JSON.parse(content);
    const date = match[1];
    const topicId = data.topic?.id || match[2];

    // topic.idからtimestampを抽出（format: topic_goal_xxx_yyy_timestamp）
    const timestampMatch = topicId.match(/_(\d+)$/);
    const cycleId = timestampMatch ? `cycle_${timestampMatch[1]}` : `research_${Date.now()}`;

    return {
      cycleId,
      filename,
      date,
      startTime: data.timestamp || "",
      endTime: data.timestamp,
      duration: 0,  // リサーチログにはduration情報がない
      success: true,  // リサーチは完了した時点で成功
      issueCount: 0,
      changeCount: 0,
      troubleCount: 0,
      cycleType: "research",
      researchTopic: data.topic?.topic || "Unknown",
      findingsCount: data.findings?.length || 0,
      approachesCount: data.approaches?.length || 0,
    };
  } catch {
    return null;
  }
}

function parseCycleLogDetail(filename: string, content: string): CycleDetail | null {
  const summary = parseCycleLogSummary(filename, content);
  if (!summary) return null;

  // Parse issues
  const issues: CycleIssue[] = [];
  const issuesSection = content.match(/## Issues Detected[\s\S]*?(?=##|$)/);
  if (issuesSection) {
    const issueRegex = /^- \[(error|warn|info)\]\s*(.+?)(?:\s*(\{[\s\S]*?\}))?$/gm;
    let issueMatch;
    while ((issueMatch = issueRegex.exec(issuesSection[0])) !== null) {
      issues.push({
        type: issueMatch[1] as "error" | "warn" | "info",
        message: issueMatch[2].trim(),
        context: issueMatch[3] ? truncateContext(issueMatch[3]) : undefined,
      });
    }
  }

  // Parse changes
  const changes: CycleChange[] = [];
  const changesSection = content.match(/## Changes Made[\s\S]*?(?=##|$)/);
  if (changesSection) {
    const changeRegex = /^- (.+?)\s*\((create|modify|delete)\)/gm;
    let changeMatch;
    while ((changeMatch = changeRegex.exec(changesSection[0])) !== null) {
      changes.push({
        file: changeMatch[1].trim(),
        changeType: changeMatch[2] as "create" | "modify" | "delete",
      });
    }
  }

  // Parse troubles
  const troubles: CycleTrouble[] = [];
  const troublesSection = content.match(/## Troubles[\s\S]*?(?=##|$)/);
  if (troublesSection) {
    const troubleRegex = /^- \[(.+?)\]\s*(.+)/gm;
    let troubleMatch;
    while ((troubleMatch = troubleRegex.exec(troublesSection[0])) !== null) {
      troubles.push({
        type: troubleMatch[1].trim(),
        message: troubleMatch[2].trim(),
      });
    }
  }

  // Parse token usage
  let tokenUsage: { input: number; output: number } | undefined;
  const tokenMatch = content.match(/\*\*Token Usage\*\*:\s*input=(\d+),?\s*output=(\d+)/);
  if (tokenMatch) {
    tokenUsage = {
      input: parseInt(tokenMatch[1], 10),
      output: parseInt(tokenMatch[2], 10),
    };
  }

  return {
    cycleId: summary.cycleId,
    filename,
    startTime: summary.startTime,
    endTime: summary.endTime,
    duration: summary.duration,
    success: summary.success,
    issues,
    changes,
    troubles,
    tokenUsage,
    rawContent: content,
    cycleType: summary.cycleType,
  };
}

function truncateContext(context: string, maxLength = 200): string {
  if (context.length <= maxLength) return context;
  return context.substring(0, maxLength) + "...";
}

router.get("/cycles", (req: Request, res: Response) => {
  const limit = Math.min(parseInt(req.query.limit as string) || 50, 200);

  if (!existsSync(MARKDOWN_LOG_DIR)) {
    const response: CycleListResponse = { count: 0, data: [] };
    res.json(response);
    return;
  }

  const allFiles = readdirSync(MARKDOWN_LOG_DIR);

  // MDログ（cycle- / research-）をすべてパース
  const mdFiles = allFiles.filter(
    (f) => f.endsWith(".md") && (f.includes(CYCLE_LOG_PREFIX) || f.includes(RESEARCH_LOG_PREFIX))
  );

  const cycles: CycleSummary[] = [];
  for (const filename of mdFiles) {
    const filePath = join(MARKDOWN_LOG_DIR, filename);
    const content = readFileSync(filePath, "utf-8");
    const summary = parseCycleLogSummary(filename, content);
    if (summary) {
      cycles.push(summary);
    }
  }

  // 後方互換: 旧形式のリサーチログ（.json）もパース
  const researchJsonFiles = allFiles
    .filter((f) => f.endsWith(".json") && f.includes(RESEARCH_LOG_PREFIX));

  for (const filename of researchJsonFiles) {
    const filePath = join(MARKDOWN_LOG_DIR, filename);
    const content = readFileSync(filePath, "utf-8");
    const summary = parseResearchLogSummary(filename, content);
    if (summary) {
      cycles.push(summary);
    }
  }

  // 日付+startTimeで降順ソート、最新順
  cycles.sort((a, b) => {
    const dateA = a.startTime || a.date;
    const dateB = b.startTime || b.date;
    return dateB.localeCompare(dateA);
  });

  // limitを適用
  const limitedCycles = cycles.slice(0, limit);

  const response: CycleListResponse = {
    count: limitedCycles.length,
    data: limitedCycles,
  };

  res.json(response);
});

router.get("/cycles/:cycleId", (req: Request, res: Response) => {
  const cycleId = req.params.cycleId;

  // Extract timestamp from cycleId (format: cycle_1234567890)
  const timestampMatch = cycleId.match(/^cycle_(\d+)$/);
  if (!timestampMatch) {
    res.status(400).json({ error: "Invalid cycle ID format" });
    return;
  }

  if (!existsSync(MARKDOWN_LOG_DIR)) {
    res.status(404).json({ error: "Cycle not found" });
    return;
  }

  const timestamp = timestampMatch[1];

  // まず修復サイクルログ（.md）を探す
  const mdFiles = readdirSync(MARKDOWN_LOG_DIR).filter(
    (f) => f.endsWith(".md") && f.includes(`cycle-${timestamp}`)
  );

  if (mdFiles.length > 0) {
    const filename = mdFiles[0];
    const filePath = join(MARKDOWN_LOG_DIR, filename);
    const content = readFileSync(filePath, "utf-8");

    const detail = parseCycleLogDetail(filename, content);
    if (!detail) {
      res.status(500).json({ error: "Failed to parse cycle log" });
      return;
    }

    const response: CycleDetailResponse = detail;
    res.json(response);
    return;
  }

  // 次にリサーチログ（.json）を探す（timestampがtopic.idの末尾に含まれる）
  const jsonFiles = readdirSync(MARKDOWN_LOG_DIR).filter(
    (f) => f.endsWith(".json") && f.includes(RESEARCH_LOG_PREFIX) && f.includes(timestamp)
  );

  if (jsonFiles.length > 0) {
    const filename = jsonFiles[0];
    const filePath = join(MARKDOWN_LOG_DIR, filename);
    const content = readFileSync(filePath, "utf-8");

    try {
      const data = JSON.parse(content);
      // リサーチログをCycleDetail形式に変換
      const detail: CycleDetail = {
        cycleId,
        filename,
        startTime: data.timestamp || "",
        endTime: data.timestamp,
        duration: 0,
        success: true,
        issues: [],
        changes: [],
        troubles: [],
        rawContent: `# Research: ${data.topic?.topic || "Unknown"}\n\n## Findings\n${(data.findings || []).map((f: { summary: string; source: string }) => `- **${f.source}**: ${f.summary}`).join("\n")}\n\n## Approaches\n${(data.approaches || []).map((a: { description: string }) => `- ${a.description}`).join("\n")}\n\n## Recommendations\n${(data.recommendations || []).map((r: string) => `- ${r}`).join("\n")}`,
      };
      res.json(detail);
    } catch {
      res.status(500).json({ error: "Failed to parse research log" });
    }
    return;
  }

  res.status(404).json({ error: "Cycle not found" });
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
