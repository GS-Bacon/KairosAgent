import { logger } from "../core/logger.js";

export interface GuardConfig {
  maxFilesPerChange: number;
  maxLinesPerFile: number;
  protectedPatterns: string[];
  allowedExtensions: string[];
}

const DEFAULT_CONFIG: GuardConfig = {
  maxFilesPerChange: 5,
  maxLinesPerFile: 500,
  protectedPatterns: [
    "src/safety/",
    "src/core/logger.ts",
    "package.json",
    "tsconfig.json",
    ".env",
  ],
  allowedExtensions: [".ts", ".js", ".json", ".md"],
};

export class Guard {
  private config: GuardConfig;

  constructor(config: Partial<GuardConfig> = {}) {
    this.config = { ...DEFAULT_CONFIG, ...config };
  }

  isFileProtected(filePath: string): boolean {
    for (const pattern of this.config.protectedPatterns) {
      if (filePath.includes(pattern)) {
        return true;
      }
    }
    return false;
  }

  isExtensionAllowed(filePath: string): boolean {
    return this.config.allowedExtensions.some((ext) => filePath.endsWith(ext));
  }

  validateChange(change: {
    files: string[];
    totalLines?: number;
  }): { allowed: boolean; reason?: string } {
    if (change.files.length > this.config.maxFilesPerChange) {
      return {
        allowed: false,
        reason: `Too many files: ${change.files.length} > ${this.config.maxFilesPerChange}`,
      };
    }

    for (const file of change.files) {
      if (this.isFileProtected(file)) {
        return {
          allowed: false,
          reason: `Protected file: ${file}`,
        };
      }

      if (!this.isExtensionAllowed(file)) {
        return {
          allowed: false,
          reason: `Disallowed extension: ${file}`,
        };
      }
    }

    if (
      change.totalLines !== undefined &&
      change.totalLines > this.config.maxLinesPerFile
    ) {
      return {
        allowed: false,
        reason: `Too many lines: ${change.totalLines} > ${this.config.maxLinesPerFile}`,
      };
    }

    return { allowed: true };
  }

  validateCodeContent(code: string): { safe: boolean; warnings: string[] } {
    const warnings: string[] = [];

    const dangerousPatterns = [
      { pattern: /eval\s*\(/, name: "eval()" },
      { pattern: /exec\s*\(/, name: "exec()" },
      { pattern: /child_process/, name: "child_process" },
      { pattern: /rm\s+-rf/, name: "rm -rf" },
      { pattern: /process\.exit/, name: "process.exit" },
      { pattern: /require\s*\(\s*['"`]\s*\+/, name: "dynamic require" },
    ];

    for (const { pattern, name } of dangerousPatterns) {
      if (pattern.test(code)) {
        warnings.push(`Potentially dangerous: ${name}`);
      }
    }

    return {
      safe: warnings.length === 0,
      warnings,
    };
  }

  getConfig(): GuardConfig {
    return { ...this.config };
  }

  updateConfig(updates: Partial<GuardConfig>): void {
    this.config = { ...this.config, ...updates };
    logger.info("Guard config updated", { config: this.config });
  }
}

export const guard = new Guard();
