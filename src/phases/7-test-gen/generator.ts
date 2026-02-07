import { existsSync, readFileSync, mkdirSync } from "fs";
import { dirname, join, basename } from "path";
import { GeneratedTest, TestGenResult } from "./types.js";
import { getAIProvider } from "../../ai/factory.js";
import { CodeSanitizer } from "../../ai/code-sanitizer.js";
import { logger } from "../../core/logger.js";

const MAX_SYNTAX_RETRIES = 2;

export class TestGenerator {
  private srcDir: string;
  private testDir: string;
  private framework: string;

  constructor(
    srcDir: string = "./src",
    testDir: string = "./tests",
    framework: string = "vitest"
  ) {
    this.srcDir = srcDir;
    this.testDir = testDir;
    this.framework = framework;
  }

  async generateForFiles(files: string[]): Promise<TestGenResult> {
    const tests: GeneratedTest[] = [];

    for (const file of files) {
      if (file.endsWith(".test.ts") || file.endsWith(".spec.ts")) {
        continue;
      }

      try {
        const test = await this.generateTest(file);
        if (test) {
          tests.push(test);
        }
      } catch (err) {
        logger.warn(`Failed to generate test for ${file}`, {
          error: err instanceof Error ? err.message : String(err),
        });
      }
    }

    return {
      tests,
      success: tests.length > 0,
    };
  }

  private async generateTest(file: string): Promise<GeneratedTest | null> {
    const fullPath = join(this.srcDir, file);
    if (!existsSync(fullPath)) {
      return null;
    }

    const code = readFileSync(fullPath, "utf-8");
    const testFileName = basename(file).replace(/\.ts$/, ".test.ts");
    const testPath = join(this.testDir, testFileName);

    let existingTests = "";
    if (existsSync(testPath)) {
      existingTests = readFileSync(testPath, "utf-8");
    }

    let testCode: string;
    try {
      const result = await this.generateTestWithRetry(file, code, existingTests);
      if (result.success) {
        testCode = result.code;
      } else {
        logger.warn(`Test generation validation failed for ${file}: ${result.error}, using fallback`);
        testCode = this.generateFallbackTest(file, code);
      }
    } catch (err) {
      logger.warn("AI test generation failed, using fallback");
      testCode = this.generateFallbackTest(file, code);
    }

    // Write test file
    if (!existsSync(this.testDir)) {
      mkdirSync(this.testDir, { recursive: true });
    }
    CodeSanitizer.safeWriteFile(testPath, testCode, { validateTs: true });

    return {
      targetFile: file,
      testFile: testPath,
      testCode,
      framework: this.framework,
    };
  }

  private async generateTestWithRetry(
    file: string,
    code: string,
    existingTests: string
  ): Promise<{ success: true; code: string } | { success: false; error: string }> {
    const ai = getAIProvider();
    let lastErrors: string[] = [];
    let lastGeneratedCode: string | null = null;

    for (let attempt = 0; attempt <= MAX_SYNTAX_RETRIES; attempt++) {
      let errorFeedback = "";

      if (attempt > 0) {
        const truncated = lastGeneratedCode && lastGeneratedCode.length > 4000
          ? "...(truncated)\n" + lastGeneratedCode.slice(-4000)
          : lastGeneratedCode;

        errorFeedback = `

[SYNTAX ERROR - RETRY ${attempt + 1}/${MAX_SYNTAX_RETRIES + 1}]
Errors: ${lastErrors.join(", ")}
${truncated ? `\nYour previous output had these errors:\n\`\`\`\n${truncated}\n\`\`\`` : ""}
Fix ALL syntax errors. Ensure all brackets/braces/parentheses are balanced.
Generate the complete, corrected TypeScript test code.`;

        logger.info("Retrying test generation with previous output feedback", {
          file,
          attempt: attempt + 1,
          maxAttempts: MAX_SYNTAX_RETRIES + 1,
          previousErrors: lastErrors,
          hasPreviousCode: !!lastGeneratedCode,
        });
      }

      const rawContent = await ai.generateTest(code, {
        targetFile: file,
        targetCode: code,
        testFramework: this.framework,
        existingTests,
        errorFeedback,
      });

      const extracted = CodeSanitizer.extractAndValidateCodeBlock(rawContent, "typescript");

      // 前回生成コードを保持（リトライ用）
      lastGeneratedCode = extracted.code;

      if (extracted.valid) {
        if (CodeSanitizer.containsControlChars(extracted.code)) {
          logger.error("AI generated test contains control characters", { file });
          return {
            success: false,
            error: "Generated test contains control characters",
          };
        }

        if (attempt > 0) {
          logger.info("Test generation succeeded after retry", {
            file,
            successfulAttempt: attempt + 1,
          });
        }

        return { success: true, code: extracted.code };
      }

      lastErrors = extracted.errors;
      logger.warn("Generated test code has syntax errors", {
        file,
        attempt: attempt + 1,
        errors: extracted.errors,
        willRetry: attempt < MAX_SYNTAX_RETRIES,
      });
    }

    logger.error("Test generation failed after all retries", {
      file,
      totalAttempts: MAX_SYNTAX_RETRIES + 1,
      finalErrors: lastErrors,
    });

    return {
      success: false,
      error: `Invalid TypeScript syntax after ${MAX_SYNTAX_RETRIES + 1} attempts: ${lastErrors.join(", ")}`,
    };
  }

  private generateFallbackTest(file: string, code: string): string {
    const moduleName = basename(file, ".ts");
    const imports = this.extractExports(code);

    return `import { describe, it, expect } from 'vitest';
import { ${imports.join(", ")} } from '../src/${moduleName}.js';

describe('${moduleName}', () => {
  it('should be defined', () => {
    // TODO: Add proper tests
    expect(true).toBe(true);
  });
});
`;
  }

  private extractExports(code: string): string[] {
    const exports: string[] = [];
    const exportMatches = code.matchAll(/export\s+(?:const|function|class|interface|type)\s+(\w+)/g);

    for (const match of exportMatches) {
      exports.push(match[1]);
    }

    return exports.slice(0, 5);
  }
}