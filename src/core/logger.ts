import { existsSync, mkdirSync, appendFileSync } from "fs";
import { join } from "path";
import { format } from "date-fns";

export type LogLevel = "debug" | "info" | "warn" | "error";

interface LogEntry {
  timestamp: string;
  level: LogLevel;
  message: string;
  context?: Record<string, unknown>;
}

export class Logger {
  private logDir: string;
  private minLevel: LogLevel;
  private levels: Record<LogLevel, number> = {
    debug: 0,
    info: 1,
    warn: 2,
    error: 3,
  };

  constructor(logDir: string = "./workspace/logs", minLevel: LogLevel = "info") {
    this.logDir = logDir;
    this.minLevel = minLevel;
    this.ensureLogDir();
  }

  private ensureLogDir(): void {
    if (!existsSync(this.logDir)) {
      mkdirSync(this.logDir, { recursive: true });
    }
  }

  private shouldLog(level: LogLevel): boolean {
    return this.levels[level] >= this.levels[this.minLevel];
  }

  private formatEntry(entry: LogEntry): string {
    const contextStr = entry.context
      ? ` ${JSON.stringify(entry.context)}`
      : "";
    return `[${entry.timestamp}] [${entry.level.toUpperCase()}] ${entry.message}${contextStr}`;
  }

  private log(level: LogLevel, message: string, context?: Record<string, unknown>): void {
    if (!this.shouldLog(level)) return;

    const now = new Date();
    const entry: LogEntry = {
      timestamp: format(now, "yyyy-MM-dd'T'HH:mm:ss.SSSxxx"),
      level,
      message,
      context,
    };

    const formatted = this.formatEntry(entry);
    console.log(formatted);

    const logFile = join(this.logDir, `${format(now, "yyyy-MM-dd")}.log`);
    appendFileSync(logFile, formatted + "\n");
  }

  debug(message: string, context?: Record<string, unknown>): void {
    this.log("debug", message, context);
  }

  info(message: string, context?: Record<string, unknown>): void {
    this.log("info", message, context);
  }

  warn(message: string, context?: Record<string, unknown>): void {
    this.log("warn", message, context);
  }

  error(message: string, context?: Record<string, unknown>): void {
    this.log("error", message, context);
  }

  getLogFile(date: Date = new Date()): string {
    return join(this.logDir, `${format(date, "yyyy-MM-dd")}.log`);
  }
}

export const logger = new Logger();
