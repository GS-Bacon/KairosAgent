import express from "express";
import { router } from "./routes.js";
import { logger } from "../core/logger.js";

export interface ServerConfig {
  port: number;
  host?: string;
}

export class APIServer {
  private app: express.Application;
  private server: ReturnType<typeof express.application.listen> | null = null;
  private config: ServerConfig;

  constructor(config: ServerConfig = { port: 3100 }) {
    this.config = config;
    this.app = express();
    this.setupMiddleware();
    this.setupRoutes();
  }

  private setupMiddleware(): void {
    this.app.use(express.json());

    this.app.use((req, _res, next) => {
      logger.debug(`${req.method} ${req.path}`);
      next();
    });

    this.app.use((err: Error, _req: express.Request, res: express.Response, _next: express.NextFunction) => {
      logger.error("API error", { error: err.message });
      res.status(500).json({ error: "Internal server error" });
    });
  }

  private setupRoutes(): void {
    this.app.use("/api", router);

    this.app.get("/", (_req, res) => {
      res.json({
        name: "MoltBot",
        version: "1.0.0",
        endpoints: {
          status: "/api/status",
          health: "/api/health",
          logs: "/api/logs",
          history: "/api/history",
          events: "/api/events",
          config: "/api/config",
          trigger: {
            check: "/api/trigger/check",
            repair: "/api/trigger/repair",
          },
        },
      });
    });
  }

  start(): Promise<void> {
    return new Promise((resolve) => {
      const host = this.config.host || "0.0.0.0";
      this.server = this.app.listen(this.config.port, host, () => {
        logger.info(`API server started on http://${host}:${this.config.port}`);
        resolve();
      });
    });
  }

  stop(): Promise<void> {
    return new Promise((resolve, reject) => {
      if (!this.server) {
        resolve();
        return;
      }

      this.server.close((err) => {
        if (err) {
          reject(err);
        } else {
          logger.info("API server stopped");
          resolve();
        }
      });
    });
  }

  getApp(): express.Application {
    return this.app;
  }
}
