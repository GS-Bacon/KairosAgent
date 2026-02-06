import { Router, Request, Response } from "express";
import { existsSync, readFileSync, readdirSync } from "fs";
import { join } from "path";
import {
  CycleSummary,
  CycleDetail,
  CycleIssue,
  CycleChange,
  CycleTrouble,
  CycleListResponse,
  CycleDetailResponse,
} from "../types.js";
import { PAGINATION, API } from "../../config/constants.js";

const cycleRouter = Router();
const MARKDOWN_LOG_DIR = "./workspace/logs";
const CYCLE_LOG_PREFIX = "cycle-";
const RESEARCH_LOG_PREFIX = "research-";

function detectCycleType(filename: string, content: string): "repair" | "research" | "optimize" | "refactor" {
  if (filename.includes("-research-")) {
    return "research";
  }
  const typeMatch = content.match(/\*\*Type\*\*:\s*🔬\s*Research/);
  if (typeMatch) {
    return "research";
  }
  return "repair";
}

function parseCycleLogSummary(filename: string, content: string): CycleSummary | null {
  const cycleMatch = filename.match(/^(\d{4}-\d{2}-\d{2})-cycle-(\d+)\.md$/);
  const researchMatch = filename.match(/^(\d{4}-\d{2}-\d{2})-research-(\w+)\.md$/);

  if (!cycleMatch && !researchMatch) return null;

  const isResearch = !!researchMatch;
  const match = isResearch ? researchMatch : cycleMatch;
  const date = match![1];
  const cycleId = isResearch ? `research_${match![2]}` : `cycle_${match![2]}`;

  const startTimeMatch = content.match(/\*\*Start(?:\s+Time)?\*\*:\s*(.+)/);
  const endTimeMatch = content.match(/\*\*End(?:\s+Time)?\*\*:\s*(.+)/);
  const durationMatch = content.match(/\*\*Duration\*\*:\s*([\d.]+)\s*seconds/);
  const statusMatch = content.match(/\*\*Status\*\*:\s*(?:✅\s*)?(?:❌\s*)?(Success|Failure)/i);

  const issuesSection = content.match(/## Issues Detected[\s\S]*?(?=##|$)/);
  const issueLines = issuesSection
    ? (issuesSection[0].match(/^- \[/gm) || []).length
    : 0;

  const changesSection = content.match(/## Changes Made[\s\S]*?(?=##|$)/);
  const changeLines = changesSection
    ? (changesSection[0].match(/^- /gm) || []).length
    : 0;

  const troublesSection = content.match(/## Troubles[\s\S]*?(?=##|$)/);
  const troubleLines = troublesSection
    ? (troublesSection[0].match(/^- /gm) || []).length
    : 0;

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

  if (cycleType === "research") {
    (summary as CycleSummary & { findingsCount?: number; approachesCount?: number }).findingsCount = findingsCount;
    (summary as CycleSummary & { findingsCount?: number; approachesCount?: number }).approachesCount = approachesCount;
  }

  return summary;
}

function parseResearchLogSummary(filename: string, content: string): CycleSummary | null {
  const match = filename.match(/^(\d{4}-\d{2}-\d{2})-research-(.+)\.json$/);
  if (!match) return null;

  try {
    const data = JSON.parse(content);
    const date = match[1];
    const topicId = data.topic?.id || match[2];

    const timestampMatch = topicId.match(/_(\d+)$/);
    const cycleId = timestampMatch ? `cycle_${timestampMatch[1]}` : `research_${Date.now()}`;

    return {
      cycleId,
      filename,
      date,
      startTime: data.timestamp || "",
      endTime: data.timestamp,
      duration: 0,
      success: true,
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

function truncateContext(context: string, maxLength = API.CONTEXT_TRUNCATION_LENGTH): string {
  if (context.length <= maxLength) return context;
  return context.substring(0, maxLength) + "...";
}

function parseCycleLogDetail(filename: string, content: string): CycleDetail | null {
  const summary = parseCycleLogSummary(filename, content);
  if (!summary) return null;

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

cycleRouter.get("/", (req: Request, res: Response) => {
  const limit = Math.min(parseInt(req.query.limit as string) || PAGINATION.CYCLES_DEFAULT, PAGINATION.CYCLES_MAX);

  if (!existsSync(MARKDOWN_LOG_DIR)) {
    const response: CycleListResponse = { count: 0, data: [] };
    res.json(response);
    return;
  }

  const allFiles = readdirSync(MARKDOWN_LOG_DIR);

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

  cycles.sort((a, b) => {
    const dateA = a.startTime || a.date;
    const dateB = b.startTime || b.date;
    return dateB.localeCompare(dateA);
  });

  const limitedCycles = cycles.slice(0, limit);

  const response: CycleListResponse = {
    count: limitedCycles.length,
    data: limitedCycles,
  };

  res.json(response);
});

cycleRouter.get("/:cycleId", (req: Request, res: Response) => {
  const cycleId = req.params.cycleId;

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

  const jsonFiles = readdirSync(MARKDOWN_LOG_DIR).filter(
    (f) => f.endsWith(".json") && f.includes(RESEARCH_LOG_PREFIX) && f.includes(timestamp)
  );

  if (jsonFiles.length > 0) {
    const filename = jsonFiles[0];
    const filePath = join(MARKDOWN_LOG_DIR, filename);
    const content = readFileSync(filePath, "utf-8");

    try {
      const data = JSON.parse(content);
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

export { cycleRouter };
