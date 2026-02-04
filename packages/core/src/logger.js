import { appendFileSync, existsSync, mkdirSync } from 'fs';
import { dirname, join } from 'path';
import { formatDateTime } from './utils.js';
export var LogLevel;
(function (LogLevel) {
    LogLevel[LogLevel["DEBUG"] = 0] = "DEBUG";
    LogLevel[LogLevel["INFO"] = 1] = "INFO";
    LogLevel[LogLevel["WARN"] = 2] = "WARN";
    LogLevel[LogLevel["ERROR"] = 3] = "ERROR";
    LogLevel[LogLevel["CRITICAL"] = 4] = "CRITICAL";
})(LogLevel || (LogLevel = {}));
class Logger {
    level = LogLevel.INFO;
    category;
    handlers = [];
    logFile = null;
    constructor(category = 'default') {
        this.category = category;
        this.handlers.push(this.consoleHandler.bind(this));
    }
    setLevel(level) {
        this.level = level;
    }
    setLogFile(path) {
        this.logFile = path;
        const dir = dirname(path);
        if (!existsSync(dir)) {
            mkdirSync(dir, { recursive: true });
        }
        this.handlers.push(this.fileHandler.bind(this));
    }
    addHandler(handler) {
        this.handlers.push(handler);
    }
    log(level, message, data) {
        if (level < this.level)
            return;
        const entry = {
            timestamp: new Date(),
            level,
            category: this.category,
            message,
            data,
        };
        for (const handler of this.handlers) {
            try {
                handler(entry);
            }
            catch (error) {
                console.error('Log handler error:', error);
            }
        }
    }
    consoleHandler(entry) {
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
        }
        else if (entry.level >= LogLevel.WARN) {
            console.warn(output);
        }
        else {
            console.log(output);
        }
    }
    fileHandler(entry) {
        if (!this.logFile)
            return;
        const levelNames = ['DEBUG', 'INFO', 'WARN', 'ERROR', 'CRITICAL'];
        const time = formatDateTime(entry.timestamp);
        let line = `[${time}] [${levelNames[entry.level]}] [${entry.category}] ${entry.message}`;
        if (entry.data !== undefined) {
            line += ` ${JSON.stringify(entry.data)}`;
        }
        appendFileSync(this.logFile, line + '\n', 'utf-8');
    }
    debug(message, data) {
        this.log(LogLevel.DEBUG, message, data);
    }
    info(message, data) {
        this.log(LogLevel.INFO, message, data);
    }
    warn(message, data) {
        this.log(LogLevel.WARN, message, data);
    }
    error(message, data) {
        this.log(LogLevel.ERROR, message, data);
    }
    critical(message, data) {
        this.log(LogLevel.CRITICAL, message, data);
    }
    child(subcategory) {
        const childLogger = new Logger(`${this.category}:${subcategory}`);
        childLogger.level = this.level;
        childLogger.logFile = this.logFile;
        childLogger.handlers = [...this.handlers];
        return childLogger;
    }
}
const loggers = new Map();
export function getLogger(category = 'default') {
    if (!loggers.has(category)) {
        loggers.set(category, new Logger(category));
    }
    return loggers.get(category);
}
export function configureGlobalLogging(options) {
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
//# sourceMappingURL=logger.js.map