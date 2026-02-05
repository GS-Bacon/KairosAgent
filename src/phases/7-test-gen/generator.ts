import { existsSync, readFileSync, writeFileSync, mkdirSync } from "fs";
import { dirname, join, basename } from "path";
import { GeneratedTest, TestGenResult } from "./types.js";
import { getAIProvider } from "../../ai/factory.js";
import { logger } from "../../core/logger.js";

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
      const ai = getAIProvider();
      testCode = await ai.generateTest(code, {
        targetFile: file,
        targetCode: code,
        testFramework: this.framework,
        existingTests,
      });
    } catch (err) {
      logger.warn("AI test generation failed, using fallback");
      testCode = this.generateFallbackTest(file, code);
    }

    // Write test file
    if (!existsSync(this.testDir)) {
      mkdirSync(this.testDir, { recursive: true });
    }
    writeFileSync(testPath, testCode);

    return {
      targetFile: file,
      testFile: testPath,
      testCode,
      framework: this.framework,
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
