import { existsSync, readFileSync, mkdirSync, unlinkSync } from "fs";
import { dirname, join } from "path";
import { RepairPlan } from "../types.js";
import { ImplementationChange, ImplementationResult } from "./types.js";
import { getAIProvider } from "../../ai/factory.js";
import { snapshotManager } from "../../safety/snapshot.js";
import { guard } from "../../safety/guard.js";
import { logger } from "../../core/logger.js";
import { eventBus } from "../../core/event-bus.js";
import { troubleCollector } from "../../trouble/index.js";
import { CodeSanitizer } from "../../ai/code-sanitizer.js";

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
      for (const step of plan.steps) {
        // Prevent double src/ prefix: if step.file already starts with src/, use it as-is
        let fullPath = step.file.startsWith("src/") || step.file.startsWith("./src/")
          ? step.file.replace(/^\.\//, "")  // Remove leading ./ if present
          : join(this.srcDir, step.file);

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
      const rawContent = await ai.generateCode(
        `Create a new file with: ${details}`,
        { file: filePath }
      );

      // ANSIエスケープ除去とコードブロック抽出
      const newContent = CodeSanitizer.extractCodeBlock(rawContent, "typescript");

      // 制御文字チェック
      if (CodeSanitizer.containsControlChars(newContent)) {
        logger.error("AI generated content contains control characters", { file: filePath });
        return {
          file: filePath,
          changeType: "create",
          success: false,
          error: "Generated content contains control characters",
        };
      }

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
      const rawContent = await ai.generateCode(
        `${details}\nFix this issue: ${issue}`,
        { file: filePath, existingCode: originalContent, issue }
      );

      // ANSIエスケープ除去とコードブロック抽出
      const newContent = CodeSanitizer.extractCodeBlock(rawContent, "typescript");

      // 制御文字チェック
      if (CodeSanitizer.containsControlChars(newContent)) {
        logger.error("AI generated content contains control characters", { file: filePath });
        return {
          file: filePath,
          changeType: "modify",
          originalContent,
          success: false,
          error: "Generated content contains control characters",
        };
      }

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

      return {
        file: filePath,
        changeType: "modify",
        originalContent,
        newContent,
        success: true,
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
