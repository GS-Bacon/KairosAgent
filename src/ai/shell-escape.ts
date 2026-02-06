/**
 * シェルエスケープユーティリティ
 * AI CLI呼び出し時の文字列エスケープを統一
 */

/**
 * シングルクォート用エスケープ
 * 'text' → 'text' (そのまま)
 * text's → text'\''s (シングルクォートを閉じて、エスケープしたシングルクォートを挿入し、再度開く)
 */
export function escapeForSingleQuote(str: string): string {
  // シングルクォート内では、シングルクォート自体を '\'' でエスケープ
  return str.replace(/'/g, "'\\''");
}

/**
 * ダブルクォート用エスケープ
 * バックスラッシュ、ダブルクォート、ドル記号、バッククォートをエスケープ
 */
export function escapeForDoubleQuote(str: string): string {
  return str
    .replace(/\\/g, "\\\\")   // バックスラッシュ
    .replace(/"/g, '\\"')     // ダブルクォート
    .replace(/\$/g, "\\$")    // ドル記号（変数展開防止）
    .replace(/`/g, "\\`");    // バッククォート（コマンド置換防止）
}

/**
 * 汎用シェルエスケープ
 * クォートスタイルに応じて適切なエスケープを適用
 */
export function escapeForShell(str: string, quoteStyle: "single" | "double" = "single"): string {
  if (quoteStyle === "single") {
    return escapeForSingleQuote(str);
  } else {
    return escapeForDoubleQuote(str);
  }
}

/**
 * シェル引数として安全な文字列を生成
 * 文字列をシングルクォートで囲む
 */
export function shellQuote(str: string): string {
  return `'${escapeForSingleQuote(str)}'`;
}

/**
 * 複数の引数をシェル用にエスケープしてスペース区切りで結合
 */
export function shellQuoteArgs(args: string[]): string {
  return args.map(shellQuote).join(" ");
}

/**
 * 環境変数の値をエスケープ（ダブルクォート用）
 */
export function escapeEnvValue(value: string): string {
  return escapeForDoubleQuote(value);
}

/**
 * コマンドライン引数の検証
 * 危険なパターンを検出
 */
export function validateCommandArg(arg: string): { safe: boolean; warning?: string } {
  // コマンドインジェクションのパターン
  const dangerousPatterns = [
    { pattern: /;\s*/, name: "command separator (;)" },
    { pattern: /\|\s*/, name: "pipe (|)" },
    { pattern: /&&\s*/, name: "and operator (&&)" },
    { pattern: /\|\|\s*/, name: "or operator (||)" },
    { pattern: /`[^`]+`/, name: "command substitution (backticks)" },
    { pattern: /\$\([^)]+\)/, name: "command substitution ($())" },
    { pattern: />\s*/, name: "redirect (>)" },
    { pattern: /<\s*/, name: "redirect (<)" },
    { pattern: /\n/, name: "newline" },
  ];

  for (const { pattern, name } of dangerousPatterns) {
    if (pattern.test(arg)) {
      return { safe: false, warning: `Dangerous pattern detected: ${name}` };
    }
  }

  return { safe: true };
}

/**
 * ヒアドキュメント用エスケープ
 * EOFマーカーと衝突する文字列をエスケープ
 */
export function escapeForHeredoc(str: string, marker: string = "EOF"): string {
  // マーカーが文字列中に存在する場合、別のマーカーを使用するよう警告
  if (str.includes(marker)) {
    throw new Error(`Heredoc marker '${marker}' found in content. Use a different marker.`);
  }
  return str;
}

/**
 * 安全なヒアドキュメントマーカーを生成
 * コンテンツと衝突しないマーカーを返す
 */
export function generateSafeHeredocMarker(content: string): string {
  const baseMarkers = ["EOF", "END", "HEREDOC", "CONTENT", "DATA"];

  for (const marker of baseMarkers) {
    if (!content.includes(marker)) {
      return marker;
    }
  }

  // すべて衝突する場合はランダムな接尾辞を追加
  let counter = 1;
  while (content.includes(`EOF${counter}`)) {
    counter++;
  }
  return `EOF${counter}`;
}
