import { existsSync, readFileSync, writeFileSync, mkdirSync, unlinkSync } from "fs";
import { dirname, join } from "path";
import { RepairPlan } from "../types.js";
import { ImplementationChange, ImplementationResult } from "./types.js";
import { getAIProvider } from "../../ai/factory.js";
import { snapshotManager } from "../../safety/snapshot.js";
import { guard } from "../../safety/guard.js";
import { logger } from "../../core/logger.js";
import { eventBus } from "../../core/event-bus.js";

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
      logger.error("Change blocked by guard", { reason: validation.reason });
      return {
        planId: plan.id,
        changes: [],
        snapshotId: "",
        success: false,
      };
    }

    // Create snapshot before making changes
    const snapshotId = snapshotManager.create(`Before plan ${plan.id}`);
    logger.info("Created pre-change snapshot", { snapshotId });

    try {
      for (const step of plan.steps) {
        const fullPath = join(this.srcDir, step.file);
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
      const newContent = await ai.generateCode(
        `Create a new file with: ${details}`,
        { file: filePath }
      );

      const contentValidation = guard.validateCodeContent(newContent);
      if (!contentValidation.safe) {
        logger.warn("Generated code has warnings", { warnings: contentValidation.warnings });
      }

      const dir = dirname(filePath);
      if (!existsSync(dir)) {
        mkdirSync(dir, { recursive: true });
      }

      writeFileSync(filePath, newContent);

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
      const newContent = await ai.generateCode(
        `${details}\nFix this issue: ${issue}`,
        { file: filePath, existingCode: originalContent, issue }
      );

      const contentValidation = guard.validateCodeContent(newContent);
      if (!contentValidation.safe) {
        logger.warn("Modified code has warnings", { warnings: contentValidation.warnings });
      }

      writeFileSync(filePath, newContent);

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
