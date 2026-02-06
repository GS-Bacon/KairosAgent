/**
 * Safe JSON Parse Utility
 *
 * try-catch内包のJSONパース。zodスキーマによるバリデーション付き。
 */

import { ZodType } from "zod";
import { logger } from "../core/logger.js";

/**
 * 安全にJSONをパースする
 * パース失敗時はnull返却+ログ出力
 * zodスキーマを渡せばバリデーション付きパース
 */
export function safeJsonParse<T>(
  content: string,
  schema?: ZodType<T>,
  context?: string,
): T | null {
  try {
    const parsed = JSON.parse(content);

    if (schema) {
      const result = schema.safeParse(parsed);
      if (!result.success) {
        logger.warn("JSON schema validation failed", {
          context: context || "unknown",
          errors: result.error.issues.map(i => `${i.path.join(".")}: ${i.message}`),
        });
        return null;
      }
      return result.data;
    }

    return parsed as T;
  } catch (error) {
    logger.warn("JSON parse failed", {
      context: context || "unknown",
      error: error instanceof Error ? error.message : String(error),
      contentPreview: content.slice(0, 100),
    });
    return null;
  }
}

/**
 * 安全にJSONをパースし、デフォルト値にフォールバック
 */
export function safeJsonParseWithDefault<T>(
  content: string,
  defaultValue: T,
  schema?: ZodType<T>,
  context?: string,
): T {
  return safeJsonParse<T>(content, schema, context) ?? defaultValue;
}
