/**
 * Atomic File Write Utility
 *
 * .tmpファイルに書き込み→renameでアトミックに置換
 * プロセスkill中のJSON破損を防止
 */

import { writeFile, writeFileSync, rename, renameSync, mkdir, mkdirSync, readFile } from "fs";
import { existsSync } from "fs";
import { dirname } from "path";
import { promisify } from "util";

const writeFileAsync = promisify(writeFile);
const renameAsync = promisify(rename);
const mkdirAsync = promisify(mkdir);
const readFileAsync = promisify(readFile);

/**
 * アトミックにファイルを書き込む（非同期版）
 * .tmpに書き込み→renameで置換（POSIXアトミック）
 */
export async function atomicWriteFile(filePath: string, data: string): Promise<void> {
  const dir = dirname(filePath);
  if (!existsSync(dir)) {
    await mkdirAsync(dir, { recursive: true });
  }

  const tmpPath = `${filePath}.tmp`;
  await writeFileAsync(tmpPath, data, "utf-8");
  await renameAsync(tmpPath, filePath);
}

/**
 * アトミックにファイルを書き込む（同期版）
 */
export function atomicWriteFileSync(filePath: string, data: string): void {
  const dir = dirname(filePath);
  if (!existsSync(dir)) {
    mkdirSync(dir, { recursive: true });
  }

  const tmpPath = `${filePath}.tmp`;
  writeFileSync(tmpPath, data, "utf-8");
  renameSync(tmpPath, filePath);
}

/**
 * ファイルを読み込む（.tmpフォールバック付き）
 * メインファイルが壊れていた場合、.tmpファイルからの復旧を試みる
 */
export async function readFileWithFallback(filePath: string): Promise<string | null> {
  const tmpPath = `${filePath}.tmp`;

  // まずメインファイルを読み込む
  try {
    if (existsSync(filePath)) {
      const content = await readFileAsync(filePath, "utf-8");
      // JSONとして有効かチェック
      JSON.parse(content);
      return content;
    }
  } catch {
    // メインファイルが壊れている場合、.tmpから復旧
  }

  // .tmpファイルからの復旧を試みる
  try {
    if (existsSync(tmpPath)) {
      const content = await readFileAsync(tmpPath, "utf-8");
      JSON.parse(content); // 有効性チェック
      // 有効なら.tmpをメインにリネーム
      await renameAsync(tmpPath, filePath);
      return content;
    }
  } catch {
    // .tmpも壊れている場合
  }

  return null;
}
