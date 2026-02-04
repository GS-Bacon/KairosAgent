import { type Config } from './types.js';
export declare function getDefaultConfig(): Config;
export declare function loadConfig(configPath?: string): Config;
export declare function saveConfig(config: Config, configPath?: string): void;
export declare function reloadConfig(configPath?: string): Config;
export declare function getConfig(): Config;
export declare function ensureDirectories(config?: Config): void;
//# sourceMappingURL=config.d.ts.map