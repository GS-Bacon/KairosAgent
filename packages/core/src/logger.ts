import { appendFileSync, existsSync, mkdirSync } from 'fs';
import { dirname, join } from 'path';
import { formatDateTime } from './utils.js';

export enum LogLevel {
  DEBUG = 0,
  INFO = 1,
  WARN = 2,
  ERROR = 3,
  CRITICAL = 4,
}

interface LogEntry {
  timestamp: Date;
  level: LogLevel;
  category: string;
  message: string;
  data?: unknown;
}

type LogHandler = (entry: LogEntry) => void;

class Logger {
  private level: LogLevel = LogLevel.INFO;
  private category: string;
  private handlers: LogHandler[] = [];
  private logFile: string | null = null;

  constructor(category: string = 'default') {
    this.category = category;
    this.handlers.push(this.consoleHandler.bind(this));
  }

  setLevel(level: LogLevel): void {
    this.level = level;
  }

  setLogFile(path: string): void {
    this.logFile = path;
    const dir = dirname(path);
    if (!existsSync(dir)) {
      mkdirSync(dir, { recursive: true });
    }
    this.handlers.push(this.fileHandler.bind(this));
  }

  addHandler(handler: LogHandler): void {
    this.handlers.push(handler);
  }

  private log(level: LogLevel, message: string, data?: unknown): void {
    if (level < this.level) return;

    const entry: LogEntry = {
      timestamp: new Date(),
      level,
      category: this.category,
      message,
      data,
    };

    for (const handler of this.handlers) {
      try {
        handler(entry);
      } catch (error) {
        console.error('Log handler error:', error);
      }
    }
  }

  private consoleHandler(entry: LogEntry): void {
    const levelNames = ['DEBUG', 'INFO', 'WARN', 'ERROR', 'CRITICAL'];
    const levelColors = ['\x1b[90m', '\x1b[36m', '\x1b[33m', '\x1b[31m', '\x1b[35m'];
    const reset = '\x1b[0m';

    const levelName = levelNames[entry.level];
    const color = levelColors[entry.level];
    const time = formatDateTime(entry.timestamp);

    let output = `${color}[${time}] [${levelName}] [${entry.category}]${reset} ${entry.message}`;

    if (entry.data !== undefined) {
      output += ` ${JSON.stringify(entry.data)}`;
    }

    if (entry.level >= LogLevel.ERROR) {
      console.error(output);
    } else if (entry.level >= LogLevel.WARN) {
      console.warn(output);
    } else {
      console.log(output);
    }
  }

  private fileHandler(entry: LogEntry): void {
    if (!this.logFile) return;

    const levelNames = ['DEBUG', 'INFO', 'WARN', 'ERROR', 'CRITICAL'];
    const time = formatDateTime(entry.timestamp);
    let line = `[${time}] [${levelNames[entry.level]}] [${entry.category}] ${entry.message}`;

    if (entry.data !== undefined) {
      line += ` ${JSON.stringify(entry.data)}`;
    }

    appendFileSync(this.logFile, line + '\n', 'utf-8');
  }

  debug(message: string, data?: unknown): void {
    this.log(LogLevel.DEBUG, message, data);
  }

  info(message: string, data?: unknown): void {
    this.log(LogLevel.INFO, message, data);
  }

  warn(message: string, data?: unknown): void {
    this.log(LogLevel.WARN, message, data);
  }

  error(message: string, data?: unknown): void {
    this.log(LogLevel.ERROR, message, data);
  }

  critical(message: string, data?: unknown): void {
    this.log(LogLevel.CRITICAL, message, data);
  }

  child(subcategory: string): Logger {
    const childLogger = new Logger(`${this.category}:${subcategory}`);
    childLogger.level = this.level;
    childLogger.logFile = this.logFile;
    childLogger.handlers = [...this.handlers];
    return childLogger;
  }
}

const loggers = new Map<string, Logger>();

export function getLogger(category: string = 'default'): Logger {
  if (!loggers.has(category)) {
    loggers.set(category, new Logger(category));
  }
  return loggers.get(category)!;
}

export function configureGlobalLogging(options: {
  level?: LogLevel;
  logDir?: string;
}): void {
  const defaultLogger = getLogger();

  if (options.level !== undefined) {
    defaultLogger.setLevel(options.level);
  }

  if (options.logDir) {
    const logFile = join(options.logDir, `${formatDateTime(new Date()).split(' ')[0]}.log`);
    defaultLogger.setLogFile(logFile);
  }
}

export { Logger };
