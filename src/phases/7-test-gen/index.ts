import { Phase, PhaseResult, CycleContext } from "../types.js";
import { TestGenerator } from "./generator.js";
import { logger } from "../../core/logger.js";

export class TestGenPhase implements Phase {
  name = "test-gen";
  private generator: TestGenerator;

  constructor() {
    this.generator = new TestGenerator();
  }

  async execute(context: CycleContext): Promise<PhaseResult> {
    if (!context.implementedChanges || context.implementedChanges.length === 0) {
      return {
        success: true,
        shouldStop: false,
        message: "No changes to generate tests for",
      };
    }

    logger.debug("Generating tests for changes");

    const changedFiles = context.implementedChanges
      .filter((c) => c.changeType !== "delete")
      .map((c) => c.file);

    if (changedFiles.length === 0) {
      return {
        success: true,
        shouldStop: false,
        message: "No files to test (all changes were deletions)",
      };
    }

    const result = await this.generator.generateForFiles(changedFiles);

    if (!result.success) {
      logger.warn("Test generation failed or produced no tests");
      return {
        success: true,
        shouldStop: false,
        message: "Could not generate tests, proceeding to verification",
        data: result,
      };
    }

    logger.info("Tests generated", { count: result.tests.length });

    return {
      success: true,
      shouldStop: false,
      message: `Generated ${result.tests.length} test files`,
      data: result,
    };
  }
}

export { TestGenerator } from "./generator.js";
export * from "./types.js";
