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

const LOG_FLUSH_INTERVAL_MS = 100;

export class Logger {
  private logDir: string;
  private minLevel: LogLevel;
  private levels: Record<LogLevel, number> = {
    debug: 0,
    info: 1,
    warn: 2,
    error: 3,
  };

  // バッファリング: 100ms間隔でバッチ書き込み
  private buffer: Map<string, string[]> = new Map();
  private flushTimer: ReturnType<typeof setInterval> | null = null;

  constructor(logDir: string = "./workspace/logs", minLevel: LogLevel = "info") {
    this.logDir = logDir;
    this.minLevel = minLevel;
    this.ensureLogDir();
    this.startFlushTimer();
  }

  private ensureLogDir(): void {
    if (!existsSync(this.logDir)) {
      mkdirSync(this.logDir, { recursive: true });
    }
  }

  private startFlushTimer(): void {
    this.flushTimer = setInterval(() => {
      this.flush();
    }, LOG_FLUSH_INTERVAL_MS);
    // プロセス終了をブロックしない
    if (this.flushTimer.unref) {
      this.flushTimer.unref();
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

    // バッファに追加（ファイルごとに分類）
    const logFile = join(this.logDir, `${format(now, "yyyy-MM-dd")}.log`);
    const existing = this.buffer.get(logFile);
    if (existing) {
      existing.push(formatted);
    } else {
      this.buffer.set(logFile, [formatted]);
    }
  }

  /**
   * バッファ内のログをファイルに書き出す
   */
  flush(): void {
    if (this.buffer.size === 0) return;

    for (const [logFile, lines] of this.buffer) {
      try {
        appendFileSync(logFile, lines.join("\n") + "\n");
      } catch {
        // ファイル書き込み失敗時は静かに落とす（無限ループ防止）
      }
    }
    this.buffer.clear();
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

  /**
   * シャットダウン時にバッファをフラッシュしタイマーを停止
   */
  shutdown(): void {
    this.flush();
    if (this.flushTimer) {
      clearInterval(this.flushTimer);
      this.flushTimer = null;
    }
  }
}

export const logger = new Logger();
