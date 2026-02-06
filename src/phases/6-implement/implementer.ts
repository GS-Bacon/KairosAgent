import { existsSync, readFileSync, mkdirSync, unlinkSync } from "fs";
import { dirname, join } from "path";
import { RepairPlan } from "../types.js";
import { ImplementationChange, ImplementationResult } from "./types.js";
import { getAIProvider } from "../../ai/factory.js";
import { AIProvider, CodeContext } from "../../ai/provider.js";
import { snapshotManager } from "../../safety/snapshot.js";
import { guard } from "../../safety/guard.js";
import { logger } from "../../core/logger.js";
import { eventBus } from "../../core/event-bus.js";
import { troubleCollector } from "../../trouble/index.js";
import { CodeSanitizer } from "../../ai/code-sanitizer.js";

/** 構文エラー時のリトライ設定 */
const SYNTAX_RETRY_CONFIG = {
  maxRetries: 2,  // 最大2回のリトライ（合計3回の試行）
};

export class CodeImplementer {
  private srcDir: string;

  constructor(srcDir: string = "./src") {
    this.srcDir = srcDir;
  }

  async implement(plan: RepairPlan): Promise<ImplementationResult> {
    const changes: ImplementationChange[] = [];

    // Validate changes first
    const validation = guard.validateChange({
      files: plan.affectedFiles,
    });

    if (!validation.allowed) {
      // 完全保護ファイルの場合は即座にブロック
      const strictlyProtectedFiles = plan.affectedFiles.filter(
        (f) => guard.isStrictlyProtected(f)
      );

      if (strictlyProtectedFiles.length > 0) {
        logger.error("Strictly protected file - change blocked", {
          reason: validation.reason,
          files: strictlyProtectedFiles,
        });
        return {
          planId: plan.id,
          changes: [],
          snapshotId: "",
          success: false,
        };
      }

      // 条件付き保護ファイルの場合はAIレビューを試みる
      const conditionallyProtectedFiles = plan.affectedFiles.filter(
        (f) => guard.isConditionallyProtected(f)
      );

      if (conditionallyProtectedFiles.length > 0) {
        logger.info("Conditionally protected files detected, requesting AI review", {
          files: conditionallyProtectedFiles,
        });

        // AI Providerを初期化（まだの場合）
        guard.initializeAIProviders();

        const reviewResult = await guard.reviewProtectedFileChange(
          conditionallyProtectedFiles[0],
          plan.description || `Plan ${plan.id}: ${plan.targetIssue?.message || plan.targetImprovement?.description || "Unknown"}`
        );

        if (reviewResult.approved) {
          logger.info("Protected file change approved by AI review", {
            files: conditionallyProtectedFiles,
            reason: reviewResult.reason,
          });
          // 続行を許可（validationを上書き）
        } else {
          logger.warn("Protected file change rejected by AI review - skipping plan", {
            files: conditionallyProtectedFiles,
            reason: reviewResult.reason,
          });
          // success: trueでスキップ（サイクル失敗にしない）
          return {
            planId: plan.id,
            changes: [],
            snapshotId: "",
            success: true,  // サイクルは成功扱い
            skipped: true,  // スキップされたことを示す
            skipReason: `Protected file change rejected: ${reviewResult.reason}`,
          };
        }
      } else {
        // 保護ファイル以外の理由でブロックされた場合
        logger.error("Change blocked by guard", { reason: validation.reason });
        return {
          planId: plan.id,
          changes: [],
          snapshotId: "",
          success: false,
        };
      }
    }

    // Create snapshot before making changes
    const snapshotId = snapshotManager.create(`Before plan ${plan.id}`);
    logger.info("Created pre-change snapshot", { snapshotId });

    try {
      // 計画ステップの重複を排除
      const deduplicatedSteps = this.deduplicatePlanSteps(plan.steps);

      for (const step of deduplicatedSteps) {
        // パス正規化を最初に適用（src/src/ 重複などを解消）
        let fullPath = this.normalizePath(step.file);

        // パス検証と自動修正
        const pathValidation = guard.validatePath(fullPath);
        if (!pathValidation.valid) {
          logger.error("Invalid path blocked", {
            path: fullPath,
            error: pathValidation.error,
            errorType: pathValidation.errorType,
          });
          changes.push({
            file: fullPath,
            changeType: step.action === "create" ? "create" : step.action === "delete" ? "delete" : "modify",
            success: false,
            error: `Path validation failed: ${pathValidation.error}`,
          });
          continue;
        }

        // 修正が適用された場合は修正後のパスを使用
        if (pathValidation.correctedPath) {
          logger.info("Path auto-corrected", {
            original: fullPath,
            corrected: pathValidation.correctedPath,
          });
          fullPath = pathValidation.correctedPath;
        }

        let change: ImplementationChange;

        switch (step.action) {
          case "create":
            change = await this.createFile(fullPath, step.details);
            break;
          case "modify":
            change = await this.modifyFile(fullPath, step.details, plan);
            break;
          case "delete":
            change = this.deleteFile(fullPath);
            break;
          default:
            change = await this.modifyFile(fullPath, step.details, plan);
        }

        changes.push(change);

        if (change.success) {
          await eventBus.emit({
            type: "modification",
            file: step.file,
            changeType: change.changeType,
            description: step.details,
          });
        }
      }

      const allSuccess = changes.every((c) => c.success);

      return {
        planId: plan.id,
        changes,
        snapshotId,
        success: allSuccess,
      };
    } catch (err) {
      logger.error("Implementation failed", {
        error: err instanceof Error ? err.message : String(err),
      });

      // 実装エラーをトラブルとして記録
      if (err instanceof Error) {
        await troubleCollector.captureFromError(err, "implement", "runtime-error", "high");
      } else {
        await troubleCollector.capture({
          phase: "implement",
          category: "runtime-error",
          severity: "high",
          message: String(err),
        });
      }

      return {
        planId: plan.id,
        changes,
        snapshotId,
        success: false,
      };
    }
  }

  private async createFile(filePath: string, details: string): Promise<ImplementationChange> {
    try {
      const ai = getAIProvider();

      // リトライループ：構文エラー時にフィードバックして再生成
      const generateResult = await this.generateCodeWithRetry(
        ai,
        `Create a new file with: ${details}`,
        { file: filePath },
        filePath,
        "create"
      );

      if (!generateResult.success) {
        return {
          file: filePath,
          changeType: "create",
          success: false,
          error: generateResult.error,
        };
      }

      const newContent = generateResult.code;

      // 制御文字チェックはgenerateCodeWithRetry内で実行済み

      const contentValidation = guard.validateCodeContent(newContent);
      if (!contentValidation.safe) {
        logger.warn("Potentially dangerous patterns detected, requesting AI review", {
          file: filePath,
          warnings: contentValidation.warnings,
        });

        // AI判断を仰ぐ
        const aiReview = await guard.validateCodeWithAI(
          newContent,
          `Creating new file: ${filePath}\nDetails: ${details}`,
          contentValidation.warnings
        );

        if (!aiReview.approved) {
          logger.error("Code blocked after AI review", {
            file: filePath,
            warnings: contentValidation.warnings,
            reason: aiReview.reason,
          });
          return {
            file: filePath,
            changeType: "create",
            success: false,
            error: `Blocked by AI review: ${aiReview.reason}`,
          };
        }

        logger.info("Code approved by AI review", {
          file: filePath,
          reason: aiReview.reason,
        });
      }

      const dir = dirname(filePath);
      if (!existsSync(dir)) {
        mkdirSync(dir, { recursive: true });
      }

      // 安全なファイル書き込み
      CodeSanitizer.safeWriteFile(filePath, newContent, { validateTs: filePath.endsWith(".ts") });

      return {
        file: filePath,
        changeType: "create",
        newContent,
        success: true,
        summary: `Created new file: ${details.slice(0, 100)}${details.length > 100 ? '...' : ''}`,
      };
    } catch (err) {
      return {
        file: filePath,
        changeType: "create",
        success: false,
        error: err instanceof Error ? err.message : String(err),
      };
    }
  }

  private async modifyFile(
    filePath: string,
    details: string,
    plan: RepairPlan
  ): Promise<ImplementationChange> {
    try {
      if (!existsSync(filePath)) {
        return this.createFile(filePath, details);
      }

      const originalContent = readFileSync(filePath, "utf-8");
      const ai = getAIProvider();

      const issue = plan.targetIssue?.message || plan.targetImprovement?.description;

      // リトライループ：構文エラー時にフィードバックして再生成
      const generateResult = await this.generateCodeWithRetry(
        ai,
        `${details}\nFix this issue: ${issue}`,
        { file: filePath, existingCode: originalContent, issue },
        filePath,
        "modify"
      );

      if (!generateResult.success) {
        return {
          file: filePath,
          changeType: "modify",
          originalContent,
          success: false,
          error: generateResult.error,
        };
      }

      const newContent = generateResult.code;

      // 制御文字チェックはgenerateCodeWithRetry内で実行済み

      const contentValidation = guard.validateCodeContent(newContent);
      if (!contentValidation.safe) {
        logger.warn("Potentially dangerous patterns in modified code, requesting AI review", {
          file: filePath,
          warnings: contentValidation.warnings,
        });

        // AI判断を仰ぐ
        const aiReview = await guard.validateCodeWithAI(
          newContent,
          `Modifying file: ${filePath}\nDetails: ${details}\nIssue: ${plan.targetIssue?.message || plan.targetImprovement?.description}`,
          contentValidation.warnings
        );

        if (!aiReview.approved) {
          logger.error("Modified code blocked after AI review", {
            file: filePath,
            warnings: contentValidation.warnings,
            reason: aiReview.reason,
          });
          return {
            file: filePath,
            changeType: "modify",
            originalContent,
            success: false,
            error: `Blocked by AI review: ${aiReview.reason}`,
          };
        }

        logger.info("Modified code approved by AI review", {
          file: filePath,
          reason: aiReview.reason,
        });
      }

      // 安全なファイル書き込み
      CodeSanitizer.safeWriteFile(filePath, newContent, { validateTs: filePath.endsWith(".ts") });

      // 変更サマリーを生成
      const summary = this.generateChangeSummary(originalContent, newContent, details);

      return {
        file: filePath,
        changeType: "modify",
        originalContent,
        newContent,
        success: true,
        summary,
        relatedIssue: plan.targetIssue?.id || plan.targetImprovement?.id,
      };
    } catch (err) {
      return {
        file: filePath,
        changeType: "modify",
        success: false,
        error: err instanceof Error ? err.message : String(err),
      };
    }
  }

  /**
   * 計画ステップの重複を排除・統合
   * 同一ファイルへの複数操作を1つに統合する
   */
  private deduplicatePlanSteps(steps: RepairPlan["steps"]): RepairPlan["steps"] {
    const fileOperations = new Map<string, RepairPlan["steps"][0]>();

    for (const step of steps) {
      const normalizedPath = this.normalizePath(step.file);
      const existing = fileOperations.get(normalizedPath);

      if (!existing) {
        // 新規ファイル
        fileOperations.set(normalizedPath, { ...step, file: normalizedPath });
      } else {
        // 重複を解決
        logger.info("Merging duplicate file operation", {
          file: normalizedPath,
          existingAction: existing.action,
          newAction: step.action,
        });

        // マージルール：
        // - create + create → 後者のdetailsで上書き
        // - create + modify → createのdetailsに統合
        // - modify + modify → detailsを連結
        // - delete が含まれる → deleteを優先
        if (step.action === "delete") {
          fileOperations.set(normalizedPath, { ...step, file: normalizedPath });
        } else if (existing.action === "delete") {
          // 既にdelete予定なら維持
        } else if (existing.action === "create" && step.action === "modify") {
          // createにmodifyの内容を統合
          existing.details = `${existing.details}\n\nAdditionally: ${step.details}`;
        } else {
          // その他: 後の操作で上書き
          existing.details = step.details;
        }
      }
    }

    const deduped = Array.from(fileOperations.values());
    if (deduped.length < steps.length) {
      logger.info("Plan steps deduplicated", {
        original: steps.length,
        deduplicated: deduped.length,
      });
    }

    return deduped;
  }

  /**
   * ファイルパスを正規化する
   * - 先頭の ./ を除去
   * - src/src/ 重複を解消
   * - src/ で始まらない場合は追加
   */
  private normalizePath(filePath: string): string {
    // 1. 先頭の ./ を除去
    let normalized = filePath.replace(/^\.\//, "");

    // 2. src/src/ 重複を解消（複数回適用）
    while (normalized.includes("src/src/")) {
      normalized = normalized.replace(/src\/src\//g, "src/");
    }

    // 3. src/ で始まる場合はそのまま使用
    if (normalized.startsWith("src/")) {
      return normalized;
    }

    // 4. src/ で始まらない場合は追加
    return join(this.srcDir, normalized);
  }

  /**
   * 変更内容のサマリーを生成
   */
  private generateChangeSummary(originalContent: string, newContent: string, details: string): string {
    const originalLines = originalContent.split('\n').length;
    const newLines = newContent.split('\n').length;
    const lineDiff = newLines - originalLines;

    // 行数の変化を記述
    let lineChange = '';
    if (lineDiff > 0) {
      lineChange = `(+${lineDiff} lines)`;
    } else if (lineDiff < 0) {
      lineChange = `(${lineDiff} lines)`;
    }

    // detailsを短縮してサマリーに
    const shortDetails = details.slice(0, 80).replace(/\n/g, ' ');
    return `${shortDetails}${shortDetails.length < details.length ? '...' : ''} ${lineChange}`.trim();
  }

  /**
   * エラーメッセージから行番号を抽出
   */
  private extractLineNumber(error: string): number | null {
    // TypeScript形式: src/file.ts(10,5): error TS2xxx
    const tsMatch = error.match(/\.ts\((\d+),\d+\)/);
    if (tsMatch) return parseInt(tsMatch[1], 10);

    // 一般形式: src/file.ts:10:5
    const generalMatch = error.match(/\.ts:(\d+):\d+/);
    if (generalMatch) return parseInt(generalMatch[1], 10);

    // 行番号のみ: line 10
    const lineMatch = error.match(/line\s+(\d+)/i);
    if (lineMatch) return parseInt(lineMatch[1], 10);

    return null;
  }

  /**
   * エラー周辺のコードコンテキストを抽出
   */
  private extractErrorContext(code: string, lineNumber: number | null, contextLines: number = 5): string | null {
    if (!lineNumber || !code) return null;

    const lines = code.split("\n");
    if (lineNumber > lines.length) return null;

    const start = Math.max(0, lineNumber - contextLines - 1);
    const end = Math.min(lines.length, lineNumber + contextLines);

    const contextWithLineNumbers = lines
      .slice(start, end)
      .map((line, idx) => {
        const ln = start + idx + 1;
        const marker = ln === lineNumber ? ">>>" : "   ";
        return `${marker} ${ln}: ${line}`;
      })
      .join("\n");

    return contextWithLineNumbers;
  }

  /**
   * 構文エラー時にリトライしてコード生成を行う
   * エラー内容とコンテキストをAIにフィードバックして修正版を再生成させる
   */
  private async generateCodeWithRetry(
    ai: AIProvider,
    prompt: string,
    context: CodeContext,
    filePath: string,
    changeType: "create" | "modify"
  ): Promise<{ success: true; code: string } | { success: false; error: string }> {
    let lastErrors: string[] = [];
    const originalContent = context.existingCode || "";

    for (let attempt = 0; attempt <= SYNTAX_RETRY_CONFIG.maxRetries; attempt++) {
      let effectivePrompt = prompt;

      // リトライ時はエラー内容とコンテキストをプロンプトに追加
      if (attempt > 0) {
        // エラーから行番号を抽出してコンテキストを取得
        const errorContextParts: string[] = [];
        for (const error of lastErrors) {
          const lineNumber = this.extractLineNumber(error);
          const errorContext = this.extractErrorContext(originalContent, lineNumber);
          if (errorContext) {
            errorContextParts.push(`Error at line ${lineNumber}:\n${errorContext}`);
          }
        }

        const errorFeedback = `

[SYNTAX ERROR DETECTED]
The previous code generation had the following errors:
${lastErrors.map((e, i) => `${i + 1}. ${e}`).join("\n")}

${errorContextParts.length > 0 ? `Error location context:\n${errorContextParts.join("\n\n")}` : ""}

IMPORTANT: Fix the syntax errors and generate valid TypeScript code.
Pay special attention to:
- Matching braces, parentheses, and brackets
- Correct import/export statements
- Proper TypeScript type annotations
- Complete function/class definitions`;

        effectivePrompt = prompt + errorFeedback;

        logger.info("Retrying code generation with error context", {
          file: filePath,
          attempt: attempt + 1,
          maxAttempts: SYNTAX_RETRY_CONFIG.maxRetries + 1,
          previousErrors: lastErrors,
          hasContext: errorContextParts.length > 0,
        });
      }

      const rawContent = await ai.generateCode(effectivePrompt, context);

      // ANSIエスケープ除去、コードブロック抽出、検証
      const extracted = CodeSanitizer.extractAndValidateCodeBlock(rawContent, "typescript");

      if (extracted.valid) {
        // 制御文字チェック
        if (CodeSanitizer.containsControlChars(extracted.code)) {
          logger.error("AI generated content contains control characters", { file: filePath });
          return {
            success: false,
            error: "Generated content contains control characters",
          };
        }

        if (attempt > 0) {
          logger.info("Code generation succeeded after retry", {
            file: filePath,
            successfulAttempt: attempt + 1,
          });
        }

        return { success: true, code: extracted.code };
      }

      // 構文エラーを記録
      lastErrors = extracted.errors;
      logger.warn("Generated code has syntax errors", {
        file: filePath,
        changeType,
        attempt: attempt + 1,
        errors: extracted.errors,
        willRetry: attempt < SYNTAX_RETRY_CONFIG.maxRetries,
      });
    }

    // 全リトライ失敗
    logger.error("Code generation failed after all retries", {
      file: filePath,
      changeType,
      totalAttempts: SYNTAX_RETRY_CONFIG.maxRetries + 1,
      finalErrors: lastErrors,
    });

    return {
      success: false,
      error: `Invalid TypeScript syntax after ${SYNTAX_RETRY_CONFIG.maxRetries + 1} attempts: ${lastErrors.join(", ")}`,
    };
  }

  private deleteFile(filePath: string): ImplementationChange {
    try {
      if (!existsSync(filePath)) {
        return {
          file: filePath,
          changeType: "delete",
          success: true,
        };
      }

      const originalContent = readFileSync(filePath, "utf-8");
      unlinkSync(filePath);

      return {
        file: filePath,
        changeType: "delete",
        originalContent,
        success: true,
      };
    } catch (err) {
      return {
        file: filePath,
        changeType: "delete",
        success: false,
        error: err instanceof Error ? err.message : String(err),
      };
    }
  }
}
