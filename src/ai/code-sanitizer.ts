import { writeFileSync, readFileSync } from "fs";
import { logger } from "../core/logger.js";
import { CODE_GENERATION } from "../config/constants.js";

/**
 * コードサニタイザー
 * AI生成コードの制御文字除去、検証、安全な書き込みを提供
 */
export class CodeSanitizer {
  /**
   * 制御文字が含まれているかチェック
   * 改行(\n)とタブ(\t)は許可
   */
  static containsControlChars(content: string): boolean {
    // \x00-\x08: NUL-BS
    // \x0b: VT (vertical tab)
    // \x0c: FF (form feed)
    // \x0e-\x1f: SO-US
    // \x7f: DEL
    // \x1b: ESC (エスケープシーケンスの開始)
    return /[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]/.test(content) ||
           /\x1b/.test(content);
  }

  /**
   * ANSIエスケープシーケンスを除去（強化版）
   * PTY制御文字、OSCシーケンス、プライベートモードシーケンスに対応
   */
  static removeAnsiCodes(content: string): string {
    return content
      // CSI sequences with optional ? (e.g., \x1b[?1004l, \x1b[?2004h)
      .replace(/\x1b\[\??[0-9;]*[a-zA-Z]/g, "")
      // Private mode sequences (h/l commands with ?)
      .replace(/\x1b\[\?[0-9;]*[hl]/g, "")
      // OSC sequences (Operating System Commands)
      .replace(/\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)/g, "")
      // Character set selection (e.g., \x1b(B, \x1b(0)
      .replace(/\x1b\([A-Za-z0-9]/g, "")
      // DCS sequences (Device Control String)
      .replace(/\x1bP[^\x1b]*\x1b\\/g, "")
      // APC sequences (Application Program Command)
      .replace(/\x1b_[^\x1b]*\x1b\\/g, "")
      // PM sequences (Privacy Message)
      .replace(/\x1b\^[^\x1b]*\x1b\\/g, "")
      // Simple escape sequences (e.g., \x1bc for reset)
      .replace(/\x1b[^[\]PO_\^][^\x1b]*/g, "")
      // Any remaining escape character followed by single char
      .replace(/\x1b./g, "")
      // Control characters (except newline \x0a and tab \x09)
      .replace(/[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]/g, "")
      .trim();
  }

  /**
   * TypeScript構文の基本検証
   * 括弧のバランス、import/export文の形式などをチェック
   */
  static isValidTypeScript(content: string): { valid: boolean; errors: string[] } {
    const errors: string[] = [];

    // 空コンテンツチェック
    if (!content || content.trim().length === 0) {
      errors.push("Content is empty");
      return { valid: false, errors };
    }

    // 括弧のバランスチェック（行番号付き）
    const brackets: Record<string, string> = { "(": ")", "[": "]", "{": "}" };
    const closingToOpening: Record<string, string> = { ")": "(", "]": "[", "}": "{" };
    const closingBrackets = new Set(Object.values(brackets));
    const stack: Array<{ expected: string; line: number; char: string }> = [];
    let inString = false;
    let stringChar = "";
    let inComment = false;
    let inMultiLineComment = false;
    let lineNumber = 1;

    for (let i = 0; i < content.length; i++) {
      const char = content[i];
      const prevChar = i > 0 ? content[i - 1] : "";
      const nextChar = i < content.length - 1 ? content[i + 1] : "";

      if (char === "\n") {
        lineNumber++;
        if (inComment) {
          inComment = false;
        }
        continue;
      }

      // コメント処理
      if (!inString) {
        if (!inComment && !inMultiLineComment && char === "/" && nextChar === "/") {
          inComment = true;
          continue;
        }
        if (!inComment && !inMultiLineComment && char === "/" && nextChar === "*") {
          inMultiLineComment = true;
          continue;
        }
        if (inMultiLineComment && char === "*" && nextChar === "/") {
          inMultiLineComment = false;
          i++; // Skip the closing /
          continue;
        }
        if (inComment || inMultiLineComment) {
          continue;
        }
      }

      // 文字列処理
      if ((char === '"' || char === "'" || char === "`") && prevChar !== "\\") {
        if (!inString) {
          inString = true;
          stringChar = char;
        } else if (char === stringChar) {
          inString = false;
          stringChar = "";
        }
        continue;
      }

      if (inString) continue;

      // 括弧チェック
      if (brackets[char]) {
        stack.push({ expected: brackets[char], line: lineNumber, char });
      } else if (closingBrackets.has(char)) {
        if (stack.length === 0) {
          errors.push(`Unexpected '${char}' at line ${lineNumber} (no matching '${closingToOpening[char]}')`);
        } else if (stack[stack.length - 1].expected !== char) {
          const top = stack.pop()!;
          errors.push(`Mismatched bracket: expected '${top.expected}' (opened '${top.char}' at line ${top.line}) but found '${char}' at line ${lineNumber}`);
        } else {
          stack.pop();
        }
      }
    }

    if (stack.length > 0) {
      const unclosed = stack
        .reverse()
        .map((s) => `'${s.expected}' (opened '${s.char}' at line ${s.line})`)
        .join(", ");
      errors.push(`Unclosed brackets: expected ${unclosed}`);
    }

    if (inString) {
      errors.push(`Unclosed string literal`);
    }

    // import文の基本検証
    const importRegex = /import\s+(?:type\s+)?(?:\{[^}]*\}|\*\s+as\s+\w+|\w+)(?:\s*,\s*(?:\{[^}]*\}|\*\s+as\s+\w+|\w+))*\s+from\s+['"][^'"]+['"]/g;
    const brokenImportRegex = /import\s+(?:type\s+)?\{[^}]*$/m;

    if (brokenImportRegex.test(content)) {
      errors.push("Incomplete import statement detected");
    }

    // export文の基本検証
    const brokenExportRegex = /export\s+(?:default\s+)?\{[^}]*$/m;
    if (brokenExportRegex.test(content)) {
      errors.push("Incomplete export statement detected");
    }

    return { valid: errors.length === 0, errors };
  }

  /**
   * コードをサニタイズ
   * ANSIエスケープ除去 + 制御文字チェック
   */
  static sanitize(content: string): { content: string; hadControlChars: boolean } {
    const sanitized = this.removeAnsiCodes(content);
    const hadControlChars = content !== sanitized;

    if (hadControlChars) {
      logger.debug("Sanitized content", {
        originalLength: content.length,
        sanitizedLength: sanitized.length,
        removedChars: content.length - sanitized.length,
      });
    }

    return { content: sanitized, hadControlChars };
  }

  /**
   * サニタイズ + 検証付きファイル書き込み
   * 制御文字が残っている場合はエラー
   */
  static safeWriteFile(filePath: string, content: string, options?: { validateTs?: boolean }): void {
    // サニタイズ
    const { content: sanitized, hadControlChars } = this.sanitize(content);

    // サニタイズ後も制御文字が残っている場合はエラー
    if (this.containsControlChars(sanitized)) {
      throw new Error(`Content contains control characters after sanitization: ${filePath}`);
    }

    // TypeScript検証（オプション）
    if (options?.validateTs && filePath.endsWith(".ts")) {
      const validation = this.isValidTypeScript(sanitized);
      if (!validation.valid) {
        logger.error("TypeScript validation failed", {
          filePath,
          errors: validation.errors
        });
        // 構文エラーがある場合はブロック
        throw new Error(`Invalid TypeScript syntax: ${validation.errors.join(", ")}`);
      }
    }

    if (hadControlChars) {
      logger.info("Writing sanitized content", { filePath });
    }

    writeFileSync(filePath, sanitized, "utf-8");
  }

  /**
   * ファイル読み込み + サニタイズ
   */
  static safeReadFile(filePath: string): string {
    const content = readFileSync(filePath, "utf-8");
    const { content: sanitized, hadControlChars } = this.sanitize(content);

    if (hadControlChars) {
      logger.warn("File contained control characters, sanitized on read", { filePath });
    }

    return sanitized;
  }

  /**
   * マークダウンコードブロックを抽出
   * AI応答からコードを取り出す
   */
  static extractCodeBlock(response: string, language?: string): string {
    // 指定言語のコードブロック
    if (language) {
      const langPattern = new RegExp(`\`\`\`${language}\\s*\\n?([\\s\\S]*?)\`\`\``, "i");
      const langMatch = response.match(langPattern);
      if (langMatch) {
        return this.removeAnsiCodes(langMatch[1].trim());
      }
    }

    // typescript/tsコードブロック
    const tsMatch = response.match(/```(?:typescript|ts)\s*\n?([\s\S]*?)```/i);
    if (tsMatch) {
      return this.removeAnsiCodes(tsMatch[1].trim());
    }

    // 汎用コードブロック
    const genericMatch = response.match(/```\s*\n?([\s\S]*?)```/);
    if (genericMatch) {
      return this.removeAnsiCodes(genericMatch[1].trim());
    }

    // コードブロックがない場合はそのまま返す
    return this.removeAnsiCodes(response.trim());
  }

  /**
   * コードブロックを抽出し、検証結果も返す
   * TypeScriptの場合は構文検証を行う
   */
  static extractAndValidateCodeBlock(
    response: string,
    language?: string
  ): { code: string; valid: boolean; errors: string[] } {
    const code = this.extractCodeBlock(response, language);

    // TypeScriptの場合は構文検証
    if (language === "typescript" || language === "ts") {
      const validation = this.isValidTypeScript(code);
      return { code, valid: validation.valid, errors: validation.errors };
    }

    // その他の言語は基本的な検証のみ
    if (!code || code.trim().length === 0) {
      return { code, valid: false, errors: ["Empty code block"] };
    }

    return { code, valid: true, errors: [] };
  }

  /**
   * 末尾の閉じ括弧不足を自動修復（単純なケースのみ）
   * 条件: エラーが "Unclosed brackets" のみ & 不足数が MAX_AUTO_REPAIR_BRACKETS 以下
   */
  static attemptBracketRepair(
    code: string
  ): { repaired: boolean; code?: string; fixes?: string[] } {
    const validation = this.isValidTypeScript(code);
    if (validation.valid) return { repaired: false };

    // Unclosed brackets エラーのみが対象
    const isBracketOnly = validation.errors.every(e =>
      e.startsWith("Unclosed brackets:")
    );
    if (!isBracketOnly || validation.errors.length !== 1) {
      return { repaired: false };
    }

    // 期待される閉じ括弧を抽出
    const expected = this.extractExpectedBrackets(validation.errors[0]);
    if (expected.length === 0 || expected.length > CODE_GENERATION.MAX_AUTO_REPAIR_BRACKETS) {
      return { repaired: false };
    }

    const repaired = code.trimEnd() + "\n" + expected.join("");
    const recheck = this.isValidTypeScript(repaired);
    if (!recheck.valid) return { repaired: false };

    return {
      repaired: true,
      code: repaired,
      fixes: [`Added ${expected.length} closing bracket(s): ${expected.join("")}`],
    };
  }

  private static extractExpectedBrackets(errorMsg: string): string[] {
    const matches = Array.from(errorMsg.matchAll(/'([}\])])'/g));
    return matches.map(m => m[1]);
  }
}

export const codeSanitizer = new CodeSanitizer();
