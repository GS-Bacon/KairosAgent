import { Phase, PhaseResult, CycleContext } from "../types.js";
import { CodeVerifier } from "./verifier.js";
import { logger } from "../../core/logger.js";

export class VerifyPhase implements Phase {
  name = "verify";
  private verifier: CodeVerifier;

  constructor() {
    this.verifier = new CodeVerifier();
  }

  async execute(context: CycleContext): Promise<PhaseResult> {
    if (!context.snapshotId) {
      return {
        success: true,
        shouldStop: true,
        message: "No snapshot to verify against (no changes made)",
      };
    }

    logger.debug("Verifying changes");

    const result = await this.verifier.verify(context.snapshotId);

    context.testResults = result.testResult
      ? {
          passed: result.testResult.passed,
          totalTests: result.testResult.totalTests,
          passedTests: result.testResult.passedTests,
          failedTests: result.testResult.failedTests,
          errors: result.testResult.errors,
        }
      : undefined;

    if (result.rolledBack) {
      logger.warn("Changes rolled back", { reason: result.rollbackReason });
      return {
        success: false,
        shouldStop: true,
        message: `Verification failed, rolled back: ${result.rollbackReason}`,
        data: result,
      };
    }

    if (result.committed) {
      logger.info("Verification passed and committed", {
        commitHash: result.commitHash,
      });
    }

    return {
      success: true,
      shouldStop: true,
      message: result.committed
        ? `Verified and committed: ${result.commitHash}`
        : "Verified (no commit needed)",
      data: result,
    };
  }
}

export { CodeVerifier } from "./verifier.js";
export * from "./types.js";
