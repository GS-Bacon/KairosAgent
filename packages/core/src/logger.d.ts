export declare enum LogLevel {
    DEBUG = 0,
    INFO = 1,
    WARN = 2,
    ERROR = 3,
    CRITICAL = 4
}
interface LogEntry {
    timestamp: Date;
    level: LogLevel;
    category: string;
    message: string;
    data?: unknown;
}
type LogHandler = (entry: LogEntry) => void;
declare class Logger {
    private level;
    private category;
    private handlers;
    private logFile;
    constructor(category?: string);
    setLevel(level: LogLevel): void;
    setLogFile(path: string): void;
    addHandler(handler: LogHandler): void;
    private log;
    private consoleHandler;
    private fileHandler;
    debug(message: string, data?: unknown): void;
    info(message: string, data?: unknown): void;
    warn(message: string, data?: unknown): void;
    error(message: string, data?: unknown): void;
    critical(message: string, data?: unknown): void;
    child(subcategory: string): Logger;
}
export declare function getLogger(category?: string): Logger;
export declare function configureGlobalLogging(options: {
    level?: LogLevel;
    logDir?: string;
}): void;
export { Logger };
//# sourceMappingURL=logger.d.ts.map