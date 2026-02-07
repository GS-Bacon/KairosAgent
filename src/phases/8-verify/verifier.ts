import { execSync } from "child_process";
import { existsSync, renameSync, mkdirSync, readFileSync, writeFileSync, unlinkSync } from "fs";
import { dirname, resolve } from "path";
import { TestResult, VerificationResult, FixResult, AnalyzedError, PushResult } from "./types.js";
import { getConfig } from "../../config/config.js";
import { gitignoreManager } from "../../git/index.js";
import { rollbackManager } from "../../safety/rollback.js";
import { guard } from "../../safety/guard.js";
import { logger } from "../../core/logger.js";
import { troubleCollector } from "../../trouble/index.js";
import { getAIProvider } from "../../ai/factory.js";
import { CodeSanitizer } from "../../ai/code-sanitizer.js";

export class CodeVerifier {
  async verify(snapshotId: string): Promise<VerificationResult> {
    const result: VerificationResult = {
      buildPassed: false,
      testsPassed: false,
      buildErrors: [],
      committed: false,
      pushed: false,
      rolledBack: false,
    };

    // Step 1: Check build
    logger.debug("Running build check");
    const buildResult = await this.checkBuild();
    result.buildPassed = buildResult.passed;
    result.buildErrors = buildResult.errors;

    if (!buildResult.passed) {
      logger.error("Build failed, initiating rollback");

      // ビルドエラーをトラブルとして記録
      await troubleCollector.captureFromBuildError(
        buildResult.errors.join("\n"),
        "verify"
      );

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

      // テスト失敗をトラブルとして記録
      for (const error of testResult.errors) {
        await troubleCollector.captureFromTestFailure(
          "test",
          error,
          "verify"
        );
      }

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
    result.gitignoreUpdated = commitResult.gitignoreUpdated;

    // Step 4: Push changes if commit succeeded
    if (commitResult.success && commitResult.hash) {
      logger.debug("Pushing changes");
      const pushResult = await this.push();
      result.pushed = pushResult.success;
      result.pushResult = pushResult;
    }

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

  private async commit(): Promise<{ success: boolean; hash?: string; gitignoreUpdated?: string[] }> {
    try {
      // git add前に.gitignoreを更新
      const gitignoreResult = await gitignoreManager.detectAndUpdate();
      const gitignoreUpdated = gitignoreResult.addedPatterns;

      execSync("git add -A", { encoding: "utf-8", stdio: "pipe" });

      const status = execSync("git status --porcelain", {
        encoding: "utf-8",
        stdio: "pipe",
      });

      if (!status.trim()) {
        logger.info("No changes to commit");
        return { success: true };
      }

      const message = `[KairosAgent] Auto-repair: ${new Date().toISOString()}`;
      execSync(`git commit -m "${message}"`, {
        encoding: "utf-8",
        stdio: "pipe",
      });

      const hash = execSync("git rev-parse --short HEAD", {
        encoding: "utf-8",
        stdio: "pipe",
      }).trim();

      logger.info("Changes committed", { hash });
      return { success: true, hash, gitignoreUpdated };
    } catch (err) {
      logger.error("Commit failed", {
        error: err instanceof Error ? err.message : String(err),
      });
      return { success: false };
    }
  }

  private async push(): Promise<PushResult> {
    const config = getConfig();

    if (!config.git.autoPush) {
      logger.debug("Auto-push disabled, skipping");
      return { success: true };
    }

    try {
      const currentBranch = execSync("git branch --show-current", {
        encoding: "utf-8",
        stdio: "pipe",
      }).trim();

      // 保護ブランチチェック
      const protectedBranches = ["main", "master"];
      if (protectedBranches.includes(currentBranch) && !config.git.allowProtectedBranchPush) {
        logger.warn("Push to protected branch skipped", { branch: currentBranch });
        return {
          success: false,
          error: "Protected branch",
          branch: currentBranch,
        };
      }

      const remote = config.git.pushRemote;

      execSync(`git push ${remote} ${currentBranch}`, {
        encoding: "utf-8",
        stdio: "pipe",
        timeout: 60000,
      });

      logger.info("Changes pushed", { remote, branch: currentBranch });
      return {
        success: true,
        remote,
        branch: currentBranch,
      };
    } catch (err) {
      const errorMessage = err instanceof Error ? err.message : String(err);
      logger.error("Push failed", { error: errorMessage });
      return {
        success: false,
        error: errorMessage,
      };
    }
  }

  private async checkCircularDeps(): Promise<{ passed: boolean; errors: string[] }> {
    try {
      execSync("npx madge --circular --extensions ts src/", {
        encoding: "utf-8",
        stdio: "pipe",
        timeout: 30000,
      });
      return { passed: true, errors: [] };
    } catch (err: unknown) {
      const errors: string[] = [];
      if (err && typeof err === "object") {
        const execErr = err as { stdout?: string; stderr?: string };
        const output = (execErr.stdout || "") + (execErr.stderr || "");
        errors.push(...output.split("\n").filter(l => l.trim()).slice(0, 20));
      }
      return { passed: false, errors };
    }
  }

  private async rollback(snapshotId: string, reason: string): Promise<void> {
    await rollbackManager.rollback(snapshotId, reason);
  }

  /**
   * 検証→修正→再検証のループを実行
   * 進捗チェック機構: 2回連続で進捗なしなら終了
   */
  async verifyWithRetry(snapshotId: string, maxRetries: number = 3): Promise<VerificationResult> {
    let lastResult: VerificationResult | null = null;
    let retryCount = 0;
    let consecutiveNoProgress = 0;
    let previousErrorCount = Infinity;

    while (retryCount <= maxRetries) {
      logger.info(`Verification attempt ${retryCount + 1}/${maxRetries + 1}`);

      // 通常の検証を実行
      const result = await this.verifyBuildOnly(snapshotId);

      if (result.buildPassed) {
        // ビルド成功ならテストも実行
        return await this.verifyWithTests(snapshotId, result);
      }

      lastResult = result;

      // ビルドエラーを分析（全エラーを対象に修正を試みる）
      const analyzedErrors = result.buildErrors.map((err) => this.analyzeError(err));
      const currentErrorCount = analyzedErrors.length;

      logger.info("Analyzed build errors", {
        total: currentErrorCount,
        mechanical: analyzedErrors.filter((e) => e.fixStrategy === "mechanical").length,
        aiRepair: analyzedErrors.filter((e) => e.fixStrategy === "ai-repair").length,
      });

      // 自動修正を試みる（全エラーを対象）
      const fixResult = await this.attemptAutoFix(analyzedErrors);
      result.autoFixAttempted = true;
      result.autoFixResult = fixResult;

      // 進捗チェック: エラー数が減ったか、修正が適用されたか
      const hasProgress = fixResult.fixedErrors.length > 0 || currentErrorCount < previousErrorCount;

      if (!hasProgress) {
        consecutiveNoProgress++;
        logger.warn("No progress in auto-fix attempt", {
          consecutiveNoProgress,
          currentErrors: currentErrorCount,
          previousErrors: previousErrorCount,
        });

        if (consecutiveNoProgress >= 2) {
          logger.error("Aborting retry: no progress for 2 consecutive attempts");
          break;
        }
      } else {
        consecutiveNoProgress = 0;
        logger.info("Auto-fix made progress", {
          fixed: fixResult.fixedErrors.length,
          remaining: fixResult.remainingErrors.length,
          changesApplied: fixResult.changesApplied,
        });
      }

      previousErrorCount = currentErrorCount;
      retryCount++;
    }

    // 最大リトライ到達、ロールバック
    if (lastResult) {
      logger.error("Max retries reached, initiating rollback", {
        attempts: retryCount,
        consecutiveNoProgress,
      });
      await this.rollback(snapshotId, "Build failed after auto-fix attempts");
      lastResult.rolledBack = true;
      lastResult.rollbackReason = `Build failed after ${retryCount} auto-fix attempts`;
      return lastResult;
    }

    // ここに到達することはないが、型の整合性のため
    return {
      buildPassed: false,
      testsPassed: false,
      buildErrors: [],
      committed: false,
      pushed: false,
      rolledBack: true,
      rollbackReason: "Unknown error",
    };
  }

  /**
   * ビルドのみの検証（テストなし）
   */
  private async verifyBuildOnly(snapshotId: string): Promise<VerificationResult> {
    const result: VerificationResult = {
      buildPassed: false,
      testsPassed: false,
      buildErrors: [],
      committed: false,
      pushed: false,
      rolledBack: false,
    };

    const buildResult = await this.checkBuild();
    result.buildPassed = buildResult.passed;
    result.buildErrors = buildResult.errors;

    if (!buildResult.passed) {
      await troubleCollector.captureFromBuildError(
        buildResult.errors.join("\n"),
        "verify"
      );
    }

    return result;
  }

  /**
   * ビルド成功後のテスト実行とコミット
   */
  private async verifyWithTests(
    snapshotId: string,
    partialResult: VerificationResult
  ): Promise<VerificationResult> {
    const result = { ...partialResult };

    // 循環依存チェック（ビルド成功後、テスト前）
    const circularResult = await this.checkCircularDeps();
    if (!circularResult.passed) {
      logger.error("Circular dependencies detected, initiating rollback", {
        cycles: circularResult.errors.length,
      });
      await troubleCollector.captureFromBuildError(
        "Circular dependencies:\n" + circularResult.errors.join("\n"),
        "verify"
      );
      await this.rollback(snapshotId, "Circular dependencies detected");
      result.rolledBack = true;
      result.rollbackReason = "Circular dependencies detected";
      return result;
    }

    logger.debug("Running tests");
    const testResult = await this.runTests();
    result.testResult = testResult;
    result.testsPassed = testResult.passed;

    if (!testResult.passed) {
      logger.error("Tests failed, initiating rollback", {
        failed: testResult.failedTests,
        errors: testResult.errors,
      });

      for (const error of testResult.errors) {
        await troubleCollector.captureFromTestFailure("test", error, "verify");
      }

      await this.rollback(snapshotId, "Tests failed");
      result.rolledBack = true;
      result.rollbackReason = `Tests failed: ${testResult.failedTests} failures`;
      return result;
    }

    logger.debug("Committing changes");
    const commitResult = await this.commit();
    result.committed = commitResult.success;
    result.commitHash = commitResult.hash;
    result.gitignoreUpdated = commitResult.gitignoreUpdated;

    // Push changes if commit succeeded
    if (commitResult.success && commitResult.hash) {
      logger.debug("Pushing changes");
      const pushResult = await this.push();
      result.pushed = pushResult.success;
      result.pushResult = pushResult;
    }

    return result;
  }

  /**
   * エラーメッセージからファイルパスと位置情報を抽出
   */
  private extractErrorLocation(error: string): { file?: string; line?: string; column?: string; errorCode?: string } {
    // TypeScript形式: src/file.ts(10,5): error TS2xxx
    const tsMatch = error.match(/([^\s:'"]+\.ts)\((\d+),(\d+)\):\s*error\s+(TS\d+)/);
    if (tsMatch) {
      return {
        file: tsMatch[1],
        line: tsMatch[2],
        column: tsMatch[3],
        errorCode: tsMatch[4],
      };
    }

    // 一般形式: src/file.ts:10:5
    const generalMatch = error.match(/([^\s:'"]+\.ts):(\d+):(\d+)/);
    if (generalMatch) {
      return {
        file: generalMatch[1],
        line: generalMatch[2],
        column: generalMatch[3],
      };
    }

    // ファイル名のみ: src/file.ts
    const fileOnlyMatch = error.match(/([^\s:'"]+\.ts)/);
    if (fileOnlyMatch) {
      return { file: fileOnlyMatch[1] };
    }

    return {};
  }

  /**
   * ビルドエラーを分析し、修正可能かどうかを判定
   * 全エラータイプをfixable=trueにし、AI修復を試みる
   */
  analyzeError(error: string): AnalyzedError {
    // 位置情報を抽出
    const location = this.extractErrorLocation(error);

    // 重複パスの検出: src/src/... パターン
    const duplicatePathMatch = error.match(/src\/src\/([^\s:'"]+)/);
    if (duplicatePathMatch) {
      return {
        type: "duplicate-path",
        fixable: true,
        fixStrategy: "mechanical",
        details: {
          ...location,
          invalidPath: `src/src/${duplicatePathMatch[1]}`,
          correctedPath: `src/${duplicatePathMatch[1]}`,
        },
        originalError: error,
      };
    }

    // モジュール未発見
    const moduleNotFoundMatch = error.match(/Cannot find module ['"]([^'"]+)['"]/);
    if (moduleNotFoundMatch) {
      const modulePath = moduleNotFoundMatch[1];
      // src/src/ パターンの検出
      if (modulePath.includes("src/src/") || modulePath.includes("/src/src/")) {
        const corrected = modulePath.replace(/src\/src\//g, "src/");
        return {
          type: "module-not-found",
          fixable: true,
          fixStrategy: "mechanical",
          details: {
            ...location,
            modulePath,
            correctedPath: corrected,
          },
          originalError: error,
        };
      }
      // AIによるモジュールパス修正を試みる
      return {
        type: "module-not-found",
        fixable: true,
        fixStrategy: "ai-repair",
        details: { ...location, modulePath },
        originalError: error,
      };
    }

    // 構文エラー（TS1xxx）- AI修復可能
    const syntaxErrorMatch = error.match(/error TS1(\d{3}):/);
    if (syntaxErrorMatch) {
      return {
        type: "syntax-error",
        fixable: true,
        fixStrategy: "ai-repair",
        details: { ...location, errorCode: `TS1${syntaxErrorMatch[1]}` },
        originalError: error,
      };
    }

    // 型エラー（TS2xxx）- AI修復可能
    const typeErrorMatch = error.match(/error TS2(\d{3}):/);
    if (typeErrorMatch) {
      return {
        type: "type-error",
        fixable: true,
        fixStrategy: "ai-repair",
        details: { ...location, errorCode: `TS2${typeErrorMatch[1]}` },
        originalError: error,
      };
    }

    // 未知のエラーもAI修復を試みる
    return {
      type: "unknown",
      fixable: true,
      fixStrategy: "ai-repair",
      details: { ...location },
      originalError: error,
    };
  }

  /**
   * 自動修正を試みる
   */
  async attemptAutoFix(errors: AnalyzedError[]): Promise<FixResult> {
    const fixedErrors: string[] = [];
    const remainingErrors: string[] = [];
    const changesApplied: string[] = [];

    for (const error of errors) {
      let fixed = false;

      // まず機械的な修正を試みる
      if (error.fixable) {
        switch (error.type) {
          case "duplicate-path":
            fixed = await this.fixDuplicatePath(error.details);
            if (fixed) {
              changesApplied.push(`Moved ${error.details.invalidPath} → ${error.details.correctedPath}`);
            }
            break;
          case "module-not-found":
            if (error.details.correctedPath && error.details.modulePath) {
              fixed = await this.fixDuplicatePath({
                invalidPath: error.details.modulePath,
                correctedPath: error.details.correctedPath,
              });
              if (fixed) {
                changesApplied.push(`Fixed module path: ${error.details.modulePath}`);
              }
            }
            break;
        }
      }

      // 機械的修正が失敗した場合、AI修正を試みる
      if (!fixed) {
        logger.info("Attempting AI fix for error", { type: error.type, error: error.originalError.slice(0, 100) });
        fixed = await this.attemptAIFix(error);
        if (fixed) {
          changesApplied.push(`AI fixed: ${error.type} error`);
        }
      }

      if (fixed) {
        fixedErrors.push(error.originalError);
      } else {
        remainingErrors.push(error.originalError);
      }
    }

    return {
      success: fixedErrors.length > 0,
      fixedErrors,
      remainingErrors,
      changesApplied,
    };
  }

  /**
   * AIによるビルドエラー修正を試みる
   */
  async attemptAIFix(error: AnalyzedError): Promise<boolean> {
    try {
      const ai = getAIProvider();

      // エラーからファイルパスと行番号を抽出
      const fileMatch = error.originalError.match(/([^\s:'"]+\.ts):(\d+)/);
      if (!fileMatch) {
        logger.debug("Could not extract file path from error", { error: error.originalError.slice(0, 100) });
        return false;
      }

      const [, filePath] = fileMatch;
      const fullPath = resolve(filePath);

      if (!existsSync(fullPath)) {
        logger.debug("File does not exist", { filePath: fullPath });
        return false;
      }

      // 保護されたファイルはスキップ
      if (guard.isFileProtected(filePath)) {
        logger.warn("Cannot AI-fix protected file", { filePath });
        return false;
      }

      const originalContent = readFileSync(fullPath, "utf-8");

      // AIに修正を依頼
      const prompt = `Fix this TypeScript build error. Return ONLY the complete fixed code, no explanations or markdown.

Error: ${error.originalError}

Current code:
${originalContent}`;

      const fixedContent = await ai.generateCode(prompt, {
        file: fullPath,
        existingCode: originalContent,
        issue: error.originalError,
      });

      // 空や明らかに無効な応答をチェック
      if (!fixedContent || fixedContent.length < 10) {
        logger.warn("AI returned empty or invalid fix");
        return false;
      }

      // コードブロック抽出 + TypeScript構文検証
      const extracted = CodeSanitizer.extractAndValidateCodeBlock(fixedContent, "typescript");
      if (!extracted.valid) {
        logger.warn("AI fix response is not valid TypeScript", { errors: extracted.errors });
        return false;
      }
      const cleanedContent = extracted.code;

      // Guard検証
      const validation = guard.validateCodeContent(cleanedContent);
      if (!validation.safe) {
        logger.info("AI fix triggered security warnings, requesting AI review", { warnings: validation.warnings });
        const aiReview = await guard.validateCodeWithAI(cleanedContent, prompt, validation.warnings);
        if (!aiReview.approved) {
          logger.warn("AI security review rejected the fix", { reason: aiReview.reason });
          return false;
        }
      }

      // バックアップを作成
      const backupPath = `${fullPath}.backup`;
      writeFileSync(backupPath, originalContent);

      // 修正を適用（サニタイズ + TypeScript検証付き）
      CodeSanitizer.safeWriteFile(fullPath, cleanedContent, { validateTs: true });
      logger.info("AI fix applied", { filePath });

      // 簡易ビルドチェック
      try {
        execSync(`npx tsc --noEmit ${fullPath}`, { encoding: "utf-8", stdio: "pipe" });
        // 成功したらバックアップを削除
        if (existsSync(backupPath)) {
          unlinkSync(backupPath);
        }
        return true;
      } catch {
        // ビルド失敗、ロールバック
        logger.warn("AI fix failed build check, rolling back", { filePath });
        writeFileSync(fullPath, originalContent);
        if (existsSync(backupPath)) {
          unlinkSync(backupPath);
        }
        return false;
      }
    } catch (err) {
      logger.error("AI fix attempt failed", { error: err instanceof Error ? err.message : String(err) });
      return false;
    }
  }

  /**
   * 重複パス問題を修正（ファイル移動）
   */
  async fixDuplicatePath(details: AnalyzedError["details"]): Promise<boolean> {
    const invalidPath = details.invalidPath;
    const correctedPath = details.correctedPath;

    if (!invalidPath || !correctedPath) {
      return false;
    }

    // パス検証
    const validation = guard.validatePath(correctedPath);
    if (!validation.valid) {
      logger.error("Corrected path is also invalid", { correctedPath, error: validation.error });
      return false;
    }

    try {
      // 不正なパスにファイルが存在するか確認
      if (existsSync(invalidPath)) {
        // 正しいパスの親ディレクトリを作成
        const dir = dirname(correctedPath);
        if (!existsSync(dir)) {
          mkdirSync(dir, { recursive: true });
        }

        // ファイルを移動
        renameSync(invalidPath, correctedPath);
        logger.info("Fixed duplicate path", { from: invalidPath, to: correctedPath });
        return true;
      }

      logger.warn("Invalid path file does not exist", { invalidPath });
      return false;
    } catch (err) {
      logger.error("Failed to fix duplicate path", {
        error: err instanceof Error ? err.message : String(err),
        invalidPath,
        correctedPath,
      });
      return false;
    }
  }
}
