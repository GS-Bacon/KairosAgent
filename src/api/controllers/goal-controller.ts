import { Router, Request, Response } from "express";
import { goalManager } from "../../goals/index.js";

const goalRouter = Router();

goalRouter.get("/", (_req: Request, res: Response) => {
  const goals = goalManager.getAllGoals();
  res.json(goals);
});

goalRouter.get("/active", (_req: Request, res: Response) => {
  const goals = goalManager.getActiveGoals();
  res.json(goals);
});

goalRouter.get("/:id", (req: Request, res: Response) => {
  const goal = goalManager.getGoal(req.params.id);
  if (!goal) {
    res.status(404).json({ error: "Goal not found" });
    return;
  }
  res.json(goal);
});

goalRouter.get("/:id/progress", (req: Request, res: Response) => {
  const progress = goalManager.getProgressHistory(req.params.id);
  res.json(progress);
});

goalRouter.post("/", (req: Request, res: Response) => {
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

goalRouter.post("/:id/deactivate", (req: Request, res: Response) => {
  const goal = goalManager.getGoal(req.params.id);
  if (!goal) {
    res.status(404).json({ error: "Goal not found" });
    return;
  }
  goalManager.deactivateGoal(req.params.id);
  res.json({ success: true, message: "Goal deactivated" });
});

goalRouter.post("/:id/reactivate", (req: Request, res: Response) => {
  const goal = goalManager.getGoal(req.params.id);
  if (!goal) {
    res.status(404).json({ error: "Goal not found" });
    return;
  }
  goalManager.reactivateGoal(req.params.id);
  res.json({ success: true, message: "Goal reactivated" });
});

export { goalRouter };
