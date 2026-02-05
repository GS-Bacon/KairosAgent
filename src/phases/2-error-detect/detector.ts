import { existsSync, readFileSync, readdirSync } from "fs";
import { join } from "path";
import { ErrorEntry, DetectionResult } from "./types.js";
import { logger } from "../../core/logger.js";

export class ErrorDetector {
  private logDir: string;

  constructor(logDir: string = "./workspace/logs") {
    this.logDir = logDir;
  }

  async detect(): Promise<DetectionResult> {
    const errors: ErrorEntry[] = [];
    const warnings: ErrorEntry[] = [];
    let totalScanned = 0;

    if (!existsSync(this.logDir)) {
      logger.debug("Log directory does not exist yet");
      return { errors, warnings, totalScanned };
    }

    const logFiles = readdirSync(this.logDir)
      .filter((f) => f.endsWith(".log"))
      .sort()
      .reverse()
      .slice(0, 7);

    for (const file of logFiles) {
      const filePath = join(this.logDir, file);
      try {
        const content = readFileSync(filePath, "utf-8");
        const lines = content.split("\n");
        totalScanned += lines.length;

        for (const line of lines) {
          if (!line.trim()) continue;

          const parsed = this.parseLine(line);
          if (!parsed) continue;

          if (parsed.level === "error") {
            errors.push(parsed);
          } else if (parsed.level === "warn") {
            warnings.push(parsed);
          }
        }
      } catch (err) {
        logger.warn(`Failed to read log file: ${file}`);
      }
    }

    return { errors, warnings, totalScanned };
  }

  private parseLine(line: string): ErrorEntry | null {
    const match = line.match(
      /\[(.+?)\]\s*\[(\w+)\]\s*(.+)/
    );
    if (!match) return null;

    const [, timestamp, level, message] = match;
    const levelLower = level.toLowerCase();

    if (levelLower !== "error" && levelLower !== "warn") {
      return null;
    }

    return {
      timestamp: new Date(timestamp),
      level: levelLower as "error" | "warn",
      message,
      source: "log",
    };
  }

  async detectBuildErrors(): Promise<ErrorEntry[]> {
    const errors: ErrorEntry[] = [];

    // Check for TypeScript compile errors
    try {
      const { execSync } = await import("child_process");
      execSync("npx tsc --noEmit 2>&1", { encoding: "utf-8" });
    } catch (err: unknown) {
      if (err && typeof err === "object" && "stdout" in err) {
        const stdout = (err as { stdout?: string }).stdout || "";
        const lines = stdout.split("\n");
        for (const line of lines) {
          if (line.includes("error TS")) {
            errors.push({
              timestamp: new Date(),
              level: "error",
              message: line.trim(),
              source: "typescript",
            });
          }
        }
      }
    }

    return errors;
  }
}
