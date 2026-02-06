import { Router, Request, Response } from "express";
import { existsSync, readFileSync, readdirSync, statSync } from "fs";
import { join } from "path";
import {
  MarkdownLogFile,
  MarkdownLogListResponse,
  MarkdownLogContentResponse,
} from "../types.js";
import { PAGINATION } from "../../config/constants.js";

const logRouter = Router();
const MARKDOWN_LOG_DIR = "./workspace/logs";

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

// Structured log entries (from .log files)
logRouter.get("/", (req: Request, res: Response) => {
  const page = parseInt(req.query.page as string) || 1;
  const limit = Math.min(parseInt(req.query.limit as string) || PAGINATION.LOGS_DEFAULT, PAGINATION.LOGS_MAX);
  const logDir = MARKDOWN_LOG_DIR;

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

// Markdown log files listing
logRouter.get("/files", (req: Request, res: Response) => {
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

// Single markdown log file content
logRouter.get("/files/:filename", (req: Request, res: Response) => {
  let filename: string;
  try {
    filename = decodeURIComponent(req.params.filename);
  } catch {
    res.status(400).json({ error: "Invalid filename encoding" });
    return;
  }

  // Path traversal prevention
  if (filename.includes("..") || filename.includes("/") || filename.includes("\\") || filename.includes("\0")) {
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
  if (!resolvedPath.startsWith(resolvedLogDir + "/") && resolvedPath !== resolvedLogDir) {
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

export { logRouter };
