import { ConfigSchema } from './types.js';
import { readFileSync, existsSync, writeFileSync, mkdirSync } from 'fs';
import { dirname, join } from 'path';
const DEFAULT_CONFIG_PATH = '/home/bacon/AutoClaudeKMP/config.json';
let cachedConfig = null;
export function getDefaultConfig() {
    return ConfigSchema.parse({
        limits: {
            maxLossJPY: 30000,
            maxCpuPercent: 30,
            maxMemoryMB: 2048,
            maxDiskGB: 10,
            maxProcesses: 20,
        },
        intervals: {
            healthCheckMs: 5 * 60 * 1000,
            heartbeatMs: 30 * 60 * 1000,
            dailyAnalysisHour: 6,
            backupHour: 3,
        },
        discord: {},
        paths: {
            workspace: '/home/bacon/AutoClaudeKMP/workspace',
            backups: '/home/bacon/AutoClaudeKMP/backups',
            sandbox: '/home/bacon/AutoClaudeKMP/sandbox',
            auth: '/home/bacon/AutoClaudeKMP/auth',
        },
    });
}
export function loadConfig(configPath = DEFAULT_CONFIG_PATH) {
    if (cachedConfig) {
        return cachedConfig;
    }
    if (!existsSync(configPath)) {
        const defaultConfig = getDefaultConfig();
        saveConfig(defaultConfig, configPath);
        cachedConfig = defaultConfig;
        return defaultConfig;
    }
    try {
        const raw = readFileSync(configPath, 'utf-8');
        const parsed = JSON.parse(raw);
        cachedConfig = ConfigSchema.parse(parsed);
        return cachedConfig;
    }
    catch (error) {
        console.error('Failed to load config, using defaults:', error);
        cachedConfig = getDefaultConfig();
        return cachedConfig;
    }
}
export function saveConfig(config, configPath = DEFAULT_CONFIG_PATH) {
    const dir = dirname(configPath);
    if (!existsSync(dir)) {
        mkdirSync(dir, { recursive: true });
    }
    writeFileSync(configPath, JSON.stringify(config, null, 2), 'utf-8');
    cachedConfig = config;
}
export function reloadConfig(configPath = DEFAULT_CONFIG_PATH) {
    cachedConfig = null;
    return loadConfig(configPath);
}
export function getConfig() {
    if (!cachedConfig) {
        return loadConfig();
    }
    return cachedConfig;
}
export function ensureDirectories(config = getConfig()) {
    const dirs = [
        config.paths.workspace,
        config.paths.backups,
        config.paths.sandbox,
        config.paths.auth,
        join(config.paths.workspace, 'memory'),
        join(config.paths.workspace, 'ledger'),
        join(config.paths.workspace, 'audit'),
        join(config.paths.workspace, 'strategies'),
    ];
    for (const dir of dirs) {
        if (!existsSync(dir)) {
            mkdirSync(dir, { recursive: true });
        }
    }
}
//# sourceMappingURL=config.js.map