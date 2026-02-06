/**
 * 堅牢なJSONパーサー
 *
 * AIレスポンスからJSONを安全に抽出する統一モジュール
 * 3段階の抽出戦略:
 * 1. マークダウンコードブロック（```json ... ```）
 * 2. バランスの取れた括弧（ネスト対応）
 * 3. フォールバック: 改善版正規表現
 */

import { logger } from "../core/logger.js";
import { ZodType, ZodError } from "zod";

export interface ParseResult<T> {
  success: boolean;
  data?: T;
  error?: string;
  method?: "code-block" | "balanced-brackets" | "regex-fallback";
}

export interface ParseOptions<T> {
  type?: "object" | "array";
  validator?: (data: unknown) => data is T;
  /** Zodスキーマによるバリデーション（validatorより優先） */
  schema?: ZodType<T>;
}

/**
 * AIレスポンスからJSONを抽出してパース
 */
export function extractJSON<T = unknown>(
  response: string,
  options: ParseOptions<T> = {}
): ParseResult<T> {
  const { type = "object", validator, schema } = options;

  // バリデーション関数: schema優先、なければvalidator
  const validate = (data: unknown): { ok: boolean; parsed?: T; error?: string } => {
    if (schema) {
      const result = schema.safeParse(data);
      if (result.success) {
        return { ok: true, parsed: result.data };
      }
      return { ok: false, error: formatZodError(result.error) };
    }
    if (validator) {
      return validator(data) ? { ok: true, parsed: data as T } : { ok: false };
    }
    return { ok: true, parsed: data as T };
  };

  // 1. マークダウンコードブロックを試す
  const codeBlockResult = extractFromCodeBlock<T>(response, type);
  if (codeBlockResult.success) {
    const v = validate(codeBlockResult.data);
    if (v.ok) {
      return { success: true, data: v.parsed, method: "code-block" };
    }
  }

  // 2. バランスの取れた括弧で抽出
  const balancedResult = extractWithBalancedBrackets<T>(response, type);
  if (balancedResult.success) {
    const v = validate(balancedResult.data);
    if (v.ok) {
      return { success: true, data: v.parsed, method: "balanced-brackets" };
    }
  }

  // 3. フォールバック: 改善版正規表現
  const regexResult = extractWithRegex<T>(response, type);
  if (regexResult.success) {
    const v = validate(regexResult.data);
    if (v.ok) {
      return { success: true, data: v.parsed, method: "regex-fallback" };
    }
    // 最後の試行のバリデーションエラーを返す
    if (v.error) {
      return { success: false, error: `Schema validation failed: ${v.error}` };
    }
  }

  // すべて失敗
  return {
    success: false,
    error: "Failed to extract valid JSON from response",
  };
}

/**
 * ZodErrorをユーザーフレンドリーな文字列に変換
 */
function formatZodError(error: ZodError): string {
  return error.issues
    .map((i) => `${i.path.join(".")}: ${i.message}`)
    .slice(0, 5)
    .join("; ");
}

/**
 * マークダウンコードブロックからJSON抽出
 */
function extractFromCodeBlock<T>(
  response: string,
  type: "object" | "array"
): ParseResult<T> {
  // ```json ... ``` または ``` ... ``` パターン
  const patterns = [
    /```json\s*([\s\S]*?)```/gi,
    /```\s*([\s\S]*?)```/gi,
  ];

  for (const pattern of patterns) {
    const matches = [...response.matchAll(pattern)];
    for (const match of matches) {
      const content = match[1].trim();
      if (!content) continue;

      // 期待するタイプに合致するか確認
      if (type === "object" && !content.startsWith("{")) continue;
      if (type === "array" && !content.startsWith("[")) continue;

      try {
        const parsed = JSON.parse(content) as T;
        return { success: true, data: parsed };
      } catch {
        // このブロックはパース失敗、次を試す
        continue;
      }
    }
  }

  return { success: false, error: "No valid JSON in code blocks" };
}

/**
 * バランスの取れた括弧を使ってJSON抽出
 */
function extractWithBalancedBrackets<T>(
  response: string,
  type: "object" | "array"
): ParseResult<T> {
  const openBracket = type === "object" ? "{" : "[";
  const closeBracket = type === "object" ? "}" : "]";

  // 開始位置を見つける
  const startIndex = response.indexOf(openBracket);
  if (startIndex === -1) {
    return { success: false, error: `No ${openBracket} found` };
  }

  // バランスを取りながら終了位置を見つける
  let depth = 0;
  let inString = false;
  let escapeNext = false;

  for (let i = startIndex; i < response.length; i++) {
    const char = response[i];

    if (escapeNext) {
      escapeNext = false;
      continue;
    }

    if (char === "\\") {
      escapeNext = true;
      continue;
    }

    if (char === '"' && !escapeNext) {
      inString = !inString;
      continue;
    }

    if (inString) continue;

    if (char === openBracket) {
      depth++;
    } else if (char === closeBracket) {
      depth--;
      if (depth === 0) {
        const jsonStr = response.substring(startIndex, i + 1);
        try {
          const parsed = JSON.parse(jsonStr) as T;
          return { success: true, data: parsed };
        } catch (e) {
          return {
            success: false,
            error: `JSON parse failed: ${e instanceof Error ? e.message : String(e)}`,
          };
        }
      }
    }
  }

  return { success: false, error: "Unbalanced brackets" };
}

/**
 * フォールバック: 改善版正規表現
 * 非greedyマッチで最初の完全なJSONを抽出
 */
function extractWithRegex<T>(
  response: string,
  type: "object" | "array"
): ParseResult<T> {
  // 最初の完全なJSON構造を見つける
  // 注意: これは完璧ではないが、シンプルなケースでは機能する
  const pattern = type === "object"
    ? /\{[^{}]*(?:\{[^{}]*\}[^{}]*)*\}/g
    : /\[[^\[\]]*(?:\[[^\[\]]*\][^\[\]]*)*\]/g;

  const matches = response.match(pattern);
  if (!matches) {
    return { success: false, error: "No JSON-like structure found" };
  }

  // 最初にパースできるものを返す
  for (const match of matches) {
    try {
      const parsed = JSON.parse(match) as T;
      return { success: true, data: parsed };
    } catch {
      continue;
    }
  }

  return { success: false, error: "No parseable JSON found" };
}

/**
 * 簡易ヘルパー: オブジェクトJSONを抽出
 */
export function parseJSONObject<T = Record<string, unknown>>(
  response: string,
  validatorOrSchema?: ((data: unknown) => data is T) | ZodType<T>
): T | null {
  const opts: ParseOptions<T> = { type: "object" };
  if (validatorOrSchema && "safeParse" in validatorOrSchema) {
    opts.schema = validatorOrSchema;
  } else if (validatorOrSchema) {
    opts.validator = validatorOrSchema as (data: unknown) => data is T;
  }
  const result = extractJSON<T>(response, opts);
  if (!result.success) {
    logger.debug("JSON object extraction failed", { error: result.error });
    return null;
  }
  return result.data ?? null;
}

/**
 * 簡易ヘルパー: 配列JSONを抽出
 */
export function parseJSONArray<T = unknown[]>(
  response: string,
  validatorOrSchema?: ((data: unknown) => data is T) | ZodType<T>
): T | null {
  const opts: ParseOptions<T> = { type: "array" };
  if (validatorOrSchema && "safeParse" in validatorOrSchema) {
    opts.schema = validatorOrSchema;
  } else if (validatorOrSchema) {
    opts.validator = validatorOrSchema as (data: unknown) => data is T;
  }
  const result = extractJSON<T>(response, opts);
  if (!result.success) {
    logger.debug("JSON array extraction failed", { error: result.error });
    return null;
  }
  return result.data ?? null;
}

/**
 * 後方互換性: 既存コードの正規表現パターンを置き換え
 * response.match(/\{[\s\S]*\}/) の代替
 */
export function extractFirstJSON(response: string): string | null {
  const result = extractJSON<unknown>(response, { type: "object" });
  if (result.success && result.data) {
    return JSON.stringify(result.data);
  }
  return null;
}
