import { Router, Request, Response } from "express";
import { improvementQueue } from "../../improvement-queue/index.js";
import { confirmationQueue } from "../../ai/confirmation-queue.js";
import { changeTracker } from "../../ai/change-tracker.js";
import { PAGINATION } from "../../config/constants.js";

const queueRouter = Router();

queueRouter.get("/improvements", async (_req: Request, res: Response) => {
  try {
    const items = await improvementQueue.getAll();
    res.json({
      count: items.length,
      data: items.map((item) => ({
        id: item.id,
        title: item.title,
        description: item.description,
        type: item.type,
        source: item.source,
        status: item.status,
        priority: item.priority,
        relatedFile: item.relatedFile,
        createdAt: item.createdAt,
        updatedAt: item.updatedAt,
      })),
    });
  } catch (error) {
    res.status(500).json({ error: "Failed to fetch improvement queue" });
  }
});

queueRouter.get("/improvements/stats", async (_req: Request, res: Response) => {
  try {
    const items = await improvementQueue.getAll();
    const stats = {
      total: items.length,
      byStatus: {
        pending: items.filter((i) => i.status === "pending").length,
        inProgress: items.filter((i) => i.status === "in_progress").length,
        completed: items.filter((i) => i.status === "completed").length,
        failed: items.filter((i) => i.status === "failed").length,
        skipped: items.filter((i) => i.status === "skipped").length,
      },
      byType: {} as Record<string, number>,
      bySource: {} as Record<string, number>,
      avgPriority: items.length > 0
        ? items.reduce((sum, i) => sum + i.priority, 0) / items.length
        : 0,
    };

    for (const item of items) {
      stats.byType[item.type] = (stats.byType[item.type] || 0) + 1;
      stats.bySource[item.source] = (stats.bySource[item.source] || 0) + 1;
    }

    res.json(stats);
  } catch (error) {
    res.status(500).json({ error: "Failed to fetch improvement queue stats" });
  }
});

queueRouter.get("/confirmations", async (_req: Request, res: Response) => {
  try {
    const items = await confirmationQueue.getAll();
    const stats = await confirmationQueue.getStats();
    res.json({
      count: items.length,
      stats,
      data: items.map((item) => ({
        id: item.id,
        changeId: item.changeId,
        status: item.status,
        priority: item.priority,
        createdAt: item.createdAt,
        reviewedAt: item.reviewedAt,
        reviewNotes: item.reviewNotes,
      })),
    });
  } catch (error) {
    res.status(500).json({ error: "Failed to fetch confirmation queue" });
  }
});

queueRouter.get("/glm-changes", (_req: Request, res: Response) => {
  try {
    const changes = changeTracker.getAllChanges();
    const stats = changeTracker.getStats();
    res.json({
      count: changes.length,
      stats,
      data: changes.slice(0, PAGINATION.GLM_CHANGES_MAX).map((change) => ({
        id: change.id,
        timestamp: change.timestamp,
        phase: change.phase,
        files: change.files,
        description: change.description,
        reviewed: change.reviewed,
        approved: change.reviewResult?.approved,
        confirmationStatus: change.confirmationStatus,
      })),
    });
  } catch (error) {
    res.status(500).json({ error: "Failed to fetch GLM changes" });
  }
});

export { queueRouter };
