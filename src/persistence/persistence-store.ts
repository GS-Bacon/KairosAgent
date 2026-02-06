/**
 * Persistence Store Interface
 *
 * 永続化層の抽象インターフェース
 * JSON, SQLite等の異なるバックエンドに差し替え可能
 */

import { ZodType } from "zod";

export interface PersistenceStore {
  /**
   * データを読み込む
   * @param key ストアのキー（ファイル名等）
   * @param schema オプショナルなZodスキーマ（バリデーション用）
   * @returns パース済みデータ、存在しない場合はnull
   */
  load<T>(key: string, schema?: ZodType<T>): Promise<T | null>;

  /**
   * データを保存する（アトミック書き込み）
   * @param key ストアのキー
   * @param data 保存するデータ
   */
  save<T>(key: string, data: T): Promise<void>;

  /**
   * キーが存在するかチェック
   */
  exists(key: string): Promise<boolean>;

  /**
   * キーを削除する
   */
  delete(key: string): Promise<boolean>;
}
