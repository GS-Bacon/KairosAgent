import { Router, Request, Response } from "express";
import { eventBus, KairosEvent } from "../../core/event-bus.js";
import { API, PAGINATION } from "../../config/constants.js";

const eventRouter = Router();

// 共有のイベント履歴（ルーター設定時にセットアップ）
const history: Array<{
  id: string;
  timestamp: string;
  type: string;
  description: string;
  files?: string[];
}> = [];

// イベント収集のセットアップ
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

  if (history.length > API.MAX_HISTORY_ENTRIES) {
    history.splice(0, history.length - API.MAX_HISTORY_ENTRIES);
  }
});

// イベント履歴取得（JSON）
eventRouter.get("/history", (req: Request, res: Response) => {
  const limit = Math.min(parseInt(req.query.limit as string) || PAGINATION.EVENTS_DEFAULT, PAGINATION.EVENTS_MAX);
  const events = history.slice(-limit);
  res.json({
    count: events.length,
    data: events,
  });
});

// SSE（Server-Sent Events）ストリーム
eventRouter.get("/", (req: Request, res: Response) => {
  res.setHeader("Content-Type", "text/event-stream");
  res.setHeader("Cache-Control", "no-cache");
  res.setHeader("Connection", "keep-alive");

  let isOpen = true;

  res.write("event: connected\n");
  res.write(`data: {"timestamp":"${new Date().toISOString()}"}\n\n`);

  const MAX_EVENT_PAYLOAD_BYTES = 10 * 1024; // 10KB

  const subscription = eventBus.onAll((event: KairosEvent) => {
    if (!isOpen) return;
    try {
      let payload = JSON.stringify(event);
      // ペイロードサイズ制限: 10KB超はメタデータのみ送信
      if (Buffer.byteLength(payload) > MAX_EVENT_PAYLOAD_BYTES) {
        payload = JSON.stringify({ type: event.type, truncated: true, timestamp: new Date().toISOString() });
      }
      res.write(`event: ${event.type}\n`);
      res.write(`data: ${payload}\n\n`);
    } catch {
      isOpen = false;
      subscription.unsubscribe();
    }
  });

  res.on("error", () => {
    isOpen = false;
    subscription.unsubscribe();
  });

  req.on("close", () => {
    isOpen = false;
    subscription.unsubscribe();
  });
});

/** history配列への参照（他コントローラからアクセス用） */
export function getHistory() {
  return history;
}

export { eventRouter };
