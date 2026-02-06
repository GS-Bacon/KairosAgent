/**
 * JSON Persistence Store
 *
 * PersistenceStoreのJSON実装
 * atomic writeとZodバリデーションを統合
 */

import { readFile } from "fs/promises";
import { existsSync, unlinkSync } from "fs";
import { join, dirname } from "path";
import { ZodType } from "zod";

import { PersistenceStore } from "./persistence-store.js";
import { atomicWriteFile } from "../utils/atomic-write.js";
import { safeJsonParse } from "../utils/safe-json.js";
import { logger } from "../core/logger.js";

export class JsonPersistenceStore implements PersistenceStore {
  private baseDir: string;

  constructor(baseDir?: string) {
    this.baseDir = baseDir || join(process.cwd(), "workspace");
  }

  private resolvePath(key: string): string {
    // keyが絶対パスの場合はそのまま使用
    if (key.startsWith("/")) {
      return key;
    }
    return join(this.baseDir, key);
  }

  async load<T>(key: string, schema?: ZodType<T>): Promise<T | null> {
    const filePath = this.resolvePath(key);

    if (!existsSync(filePath)) {
      // .tmpフォールバック: メインファイルがない場合にtmpから回復
      const tmpPath = `${filePath}.tmp`;
      if (existsSync(tmpPath)) {
        logger.warn("Main file missing, recovering from .tmp", { key });
        try {
          const content = await readFile(tmpPath, "utf-8");
          const data = safeJsonParse<T>(content, schema, key);
          if (data !== null) {
            // 回復成功: メインファイルに書き戻す
            await atomicWriteFile(filePath, content);
            return data;
          }
        } catch {
          logger.warn("Failed to recover from .tmp", { key });
        }
      }
      return null;
    }

    try {
      const content = await readFile(filePath, "utf-8");
      return safeJsonParse<T>(content, schema, key);
    } catch (error) {
      logger.warn("Failed to load data", { key, error });
      return null;
    }
  }

  async save<T>(key: string, data: T): Promise<void> {
    const filePath = this.resolvePath(key);
    const content = JSON.stringify(data, null, 2);
    await atomicWriteFile(filePath, content);
  }

  async exists(key: string): Promise<boolean> {
    const filePath = this.resolvePath(key);
    return existsSync(filePath);
  }

  async delete(key: string): Promise<boolean> {
    const filePath = this.resolvePath(key);
    if (!existsSync(filePath)) {
      return false;
    }
    try {
      unlinkSync(filePath);
      return true;
    } catch (error) {
      logger.warn("Failed to delete file", { key, error });
      return false;
    }
  }
}

/** グローバルインスタンス */
export const jsonStore = new JsonPersistenceStore();
