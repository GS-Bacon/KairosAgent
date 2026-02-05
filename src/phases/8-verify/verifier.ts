import { execSync } from "child_process";
import { TestResult, VerificationResult } from "./types.js";
import { rollbackManager } from "../../safety/rollback.js";
import { logger } from "../../core/logger.js";

export class CodeVerifier {
  async verify(snapshotId: string): Promise<VerificationResult> {
    const result: VerificationResult = {
      buildPassed: false,
      testsPassed: false,
      buildErrors: [],
      committed: false,
      rolledBack: false,
    };

    // Step 1: Check build
    logger.debug("Running build check");
    const buildResult = await this.checkBuild();
    result.buildPassed = buildResult.passed;
    result.buildErrors = buildResult.errors;

    if (!buildResult.passed) {
      logger.error("Build failed, initiating rollback");
      await this.rollback(snapshotId, "Build failed");
      result.rolledBack = true;
      result.rollbackReason = "Build failed";
      return result;
    }

    // Step 2: Run tests
    logger.debug("Running tests");
    const testResult = await this.runTests();
    result.testResult = testResult;
    result.testsPassed = testResult.passed;

    if (!testResult.passed) {
      logger.error("Tests failed, initiating rollback", {
        failed: testResult.failedTests,
        errors: testResult.errors,
      });
      await this.rollback(snapshotId, "Tests failed");
      result.rolledBack = true;
      result.rollbackReason = `Tests failed: ${testResult.failedTests} failures`;
      return result;
    }

    // Step 3: Commit changes
    logger.debug("Committing changes");
    const commitResult = await this.commit();
    result.committed = commitResult.success;
    result.commitHash = commitResult.hash;

    return result;
  }

  private async checkBuild(): Promise<{ passed: boolean; errors: string[] }> {
    try {
      execSync("npm run build", {
        encoding: "utf-8",
        stdio: "pipe",
      });
      return { passed: true, errors: [] };
    } catch (err: unknown) {
      const errors: string[] = [];
      if (err && typeof err === "object") {
        const execErr = err as { stdout?: string; stderr?: string };
        const output = (execErr.stdout || "") + (execErr.stderr || "");
        const errorLines = output
          .split("\n")
          .filter((l) => l.includes("error"));
        errors.push(...errorLines.slice(0, 10));
      }
      return { passed: false, errors };
    }
  }

  private async runTests(): Promise<TestResult> {
    const start = Date.now();
    try {
      const output = execSync("npm test 2>&1", {
        encoding: "utf-8",
        stdio: "pipe",
      });

      // Parse vitest output
      const passMatch = output.match(/(\d+)\s+passed/);
      const failMatch = output.match(/(\d+)\s+failed/);

      const passed = passMatch ? parseInt(passMatch[1], 10) : 0;
      const failed = failMatch ? parseInt(failMatch[1], 10) : 0;

      return {
        passed: failed === 0,
        totalTests: passed + failed,
        passedTests: passed,
        failedTests: failed,
        errors: [],
        duration: Date.now() - start,
      };
    } catch (err: unknown) {
      const errors: string[] = [];
      if (err && typeof err === "object") {
        const execErr = err as { stdout?: string; stderr?: string };
        const output = (execErr.stdout || "") + (execErr.stderr || "");
        const errorLines = output
          .split("\n")
          .filter((l) => l.includes("FAIL") || l.includes("Error"))
          .slice(0, 10);
        errors.push(...errorLines);
      }

      return {
        passed: false,
        totalTests: 0,
        passedTests: 0,
        failedTests: 1,
        errors,
        duration: Date.now() - start,
      };
    }
  }

  private async commit(): Promise<{ success: boolean; hash?: string }> {
    try {
      execSync("git add -A", { encoding: "utf-8", stdio: "pipe" });

      const status = execSync("git status --porcelain", {
        encoding: "utf-8",
        stdio: "pipe",
      });

      if (!status.trim()) {
        logger.info("No changes to commit");
        return { success: true };
      }

      const message = `[MoltBot] Auto-repair: ${new Date().toISOString()}`;
      execSync(`git commit -m "${message}"`, {
        encoding: "utf-8",
        stdio: "pipe",
      });

      const hash = execSync("git rev-parse --short HEAD", {
        encoding: "utf-8",
        stdio: "pipe",
      }).trim();

      logger.info("Changes committed", { hash });
      return { success: true, hash };
    } catch (err) {
      logger.error("Commit failed", {
        error: err instanceof Error ? err.message : String(err),
      });
      return { success: false };
    }
  }

  private async rollback(snapshotId: string, reason: string): Promise<void> {
    await rollbackManager.rollback(snapshotId, reason);
  }
}
