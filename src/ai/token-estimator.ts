/**
 * Token Estimator
 *
 * トークン数の推定と閾値チェック
 * 正確なトークン化は不要で、~4文字/トークンの概算で十分
 */

import { CODE_GENERATION } from "../config/constants.js";

/** 大規模コードの閾値（文字数） */
export const LARGE_CODE_THRESHOLD = CODE_GENERATION.LARGE_CODE_THRESHOLD;

/** 差分プロンプトで提示するエラー周辺の行数 */
export const CONTEXT_LINES = CODE_GENERATION.CONTEXT_LINES;

/**
 * 文字数からトークン数を概算
 * 英語テキストは約4文字/トークン、コードは3.5文字/トークン程度
 */
export function estimateTokens(text: string): number {
  return Math.ceil(text.length / 3.5);
}

/**
 * コードが大規模かどうかを判定
 */
export function isLargeCode(code: string): boolean {
  return code.length > LARGE_CODE_THRESHOLD;
}

/**
 * エラー周辺のコンテキストを抽出
 * import/export文 + エラー周辺±contextLines行を返す
 */
export function extractRelevantContext(
  code: string,
  errorLines?: number[],
  contextLines: number = CONTEXT_LINES,
): string {
  const lines = code.split("\n");
  const relevantLines = new Set<number>();

  // import/export文は常に含める
  lines.forEach((line, idx) => {
    if (/^(import|export)\s/.test(line.trim())) {
      relevantLines.add(idx);
    }
  });

  // エラー行周辺を含める
  if (errorLines && errorLines.length > 0) {
    for (const errorLine of errorLines) {
      const lineIdx = errorLine - 1; // 0-indexed
      const start = Math.max(0, lineIdx - contextLines);
      const end = Math.min(lines.length - 1, lineIdx + contextLines);
      for (let i = start; i <= end; i++) {
        relevantLines.add(i);
      }
    }
  } else {
    // エラー行が指定されない場合、先頭と末尾を含める
    for (let i = 0; i < Math.min(contextLines, lines.length); i++) {
      relevantLines.add(i);
    }
    for (let i = Math.max(0, lines.length - contextLines); i < lines.length; i++) {
      relevantLines.add(i);
    }
  }

  // ソートして連続範囲をマージ
  const sortedIndices = Array.from(relevantLines).sort((a, b) => a - b);

  const result: string[] = [];
  let lastIdx = -2;

  for (const idx of sortedIndices) {
    if (idx > lastIdx + 1) {
      if (result.length > 0) {
        result.push(`... (${idx - lastIdx - 1} lines omitted) ...`);
      }
    }
    result.push(`${idx + 1}: ${lines[idx]}`);
    lastIdx = idx;
  }

  return result.join("\n");
}

/**
 * 差分ベースのプロンプトを生成
 */
export function buildDiffPrompt(
  filePath: string,
  relevantContext: string,
  issue: string,
  details: string,
): string {
  return `The file "${filePath}" is too large to include fully.
Here are the relevant sections (import/export statements and error context):

\`\`\`typescript
${relevantContext}
\`\`\`

Issue to fix: ${issue}
Task: ${details}

IMPORTANT: Output ONLY the changes as a unified diff format (lines starting with + or -).
Do NOT output the entire file. Output only the specific modifications needed.
Include enough context lines (starting with space) for accurate patching.`;
}
