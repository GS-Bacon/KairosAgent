import { Router, Request, Response } from "express";
import { snapshotManager } from "../../safety/snapshot.js";
import { rollbackManager } from "../../safety/rollback.js";
import { PAGINATION } from "../../config/constants.js";

const snapshotRouter = Router();

snapshotRouter.get("/snapshots", (req: Request, res: Response) => {
  const limit = Math.min(parseInt(req.query.limit as string) || PAGINATION.SNAPSHOTS_DEFAULT, PAGINATION.SNAPSHOTS_MAX);
  const snapshots = snapshotManager.list().slice(0, limit);
  res.json({
    count: snapshots.length,
    data: snapshots,
  });
});

snapshotRouter.get("/rollbacks", (req: Request, res: Response) => {
  const limit = Math.min(parseInt(req.query.limit as string) || PAGINATION.SNAPSHOTS_DEFAULT, PAGINATION.SNAPSHOTS_MAX);
  const rollbacks = rollbackManager.getHistory().slice(0, limit);
  res.json({
    count: rollbacks.length,
    data: rollbacks,
  });
});

export { snapshotRouter };
