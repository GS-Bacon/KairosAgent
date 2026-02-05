/**
 * Trouble Collector
 *
 * 各フェーズからトラブルを収集し、構造化して記録する
 */

import { eventBus } from "../core/event-bus.js";
import { troubleRepository } from "./repository.js";
import {
  Trouble,
  TroubleInput,
  TroubleCategory,
  TroubleSeverity,
} from "./types.js";

class TroubleCollector {
  private currentCycleId: string | null = null;
  private pendingTroubles: Trouble[] = [];
  private recentTroubles: Trouble[] = []; // 重複チェック用キャッシュ
  private readonly DEDUP_WINDOW = 20; // 直近20件との重複チェック

  setCycleId(cycleId: string): void {
    this.currentCycleId = cycleId;
    this.pendingTroubles = [];
  }

  /**
   * 重複トラブルかどうかをチェック
   * message + file + category が一致する場合は重複とみなす
   */
  private isDuplicate(input: TroubleInput): boolean {
    // pending + recentTroubles から直近のものをチェック
    const checkTargets = [...this.pendingTroubles, ...this.recentTroubles].slice(
      -this.DEDUP_WINDOW
    );

    for (const existing of checkTargets) {
      if (
        existing.message === input.message &&
        existing.file === input.file &&
        existing.category === input.category
      ) {
        return true;
      }
    }
    return false;
  }

  /**
   * 重複チェック用キャッシュを更新（サイクル開始時に呼ぶ）
   */
  async loadRecentTroubles(): Promise<void> {
    try {
      this.recentTroubles = await troubleRepository.getRecent(this.DEDUP_WINDOW);
    } catch {
      this.recentTroubles = [];
    }
  }

  /**
   * トラブルをキャプチャして記録
   * 重複時は既存のトラブルを返す（新規記録しない）
   */
  async capture(input: TroubleInput): Promise<Trouble | null> {
    // 重複チェック
    if (this.isDuplicate(input)) {
      console.log(
        `[TroubleCollector] Skipping duplicate trouble: ${input.category} - ${input.message?.slice(0, 50)}`
      );
      return null;
    }

    const trouble: Trouble = {
      id: `trouble_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`,
      cycleId: this.currentCycleId || "unknown",
      phase: input.phase,
      category: input.category,
      severity: input.severity,
      message: input.message,
      file: input.file,
      line: input.line,
      column: input.column,
      stackTrace: input.stackTrace,
      context: input.context,
      resolved: false,
      occurredAt: new Date().toISOString(),
    };

    this.pendingTroubles.push(trouble);

    // イベント発行
    await eventBus.emit({
      type: "trouble_captured",
      trouble: {
        id: trouble.id,
        category: trouble.category,
        severity: trouble.severity,
        message: trouble.message,
        phase: trouble.phase,
      },
      timestamp: new Date(),
    });

    return trouble;
  }

  /**
   * エラーオブジェクトからトラブルをキャプチャ
   */
  async captureFromError(
    error: Error,
    phase: string,
    category: TroubleCategory = "runtime-error",
    severity: TroubleSeverity = "high"
  ): Promise<Trouble | null> {
    const fileMatch = error.stack?.match(/at\s+(?:.+?\s+)?\(?(.+?):(\d+):(\d+)\)?/);

    return this.capture({
      phase,
      category,
      severity,
      message: error.message,
      file: fileMatch?.[1],
      line: fileMatch?.[2] ? parseInt(fileMatch[2], 10) : undefined,
      column: fileMatch?.[3] ? parseInt(fileMatch[3], 10) : undefined,
      stackTrace: error.stack,
      context: { errorName: error.name },
    });
  }

  /**
   * ビルドエラーからトラブルをキャプチャ
   */
  async captureFromBuildError(
    output: string,
    phase: string
  ): Promise<Trouble[]> {
    const troubles: Trouble[] = [];
    const lines = output.split("\n");

    // TypeScript/Node.js エラーパターン
    const errorPatterns = [
      // TSエラー: src/file.ts(10,5): error TS2304: ...
      /(.+?)\((\d+),(\d+)\):\s*(error|warning)\s+(TS\d+):\s*(.+)/,
      // ESLint: src/file.ts:10:5: error ...
      /(.+?):(\d+):(\d+):\s*(error|warning)\s+(.+)/,
      // 一般的なエラー: Error: message
      /^(error|Error|ERROR):\s*(.+)/i,
    ];

    for (const line of lines) {
      for (const pattern of errorPatterns) {
        const match = line.match(pattern);
        if (match) {
          const isWarning =
            match[4]?.toLowerCase() === "warning" ||
            line.toLowerCase().includes("warning");

          const captured = await this.capture({
            phase,
            category: isWarning ? "lint-error" : "build-error",
            severity: isWarning ? "low" : "high",
            message: match[6] || match[5] || match[2] || line,
            file: match[1]?.includes("/") ? match[1] : undefined,
            line: match[2] ? parseInt(match[2], 10) : undefined,
            column: match[3] ? parseInt(match[3], 10) : undefined,
            context: {
              errorCode: match[5],
              rawLine: line,
            },
          });
          if (captured) {
            troubles.push(captured);
          }
          break;
        }
      }
    }

    // パターンマッチしなかった場合、出力全体を記録
    if (troubles.length === 0 && output.trim()) {
      const captured = await this.capture({
        phase,
        category: "build-error",
        severity: "high",
        message: output.slice(0, 500),
        context: { fullOutput: output },
      });
      if (captured) {
        troubles.push(captured);
      }
    }

    return troubles;
  }

  /**
   * テスト失敗からトラブルをキャプチャ
   */
  async captureFromTestFailure(
    testName: string,
    error: string,
    phase: string,
    file?: string
  ): Promise<Trouble | null> {
    return this.capture({
      phase,
      category: "test-failure",
      severity: "medium",
      message: `Test failed: ${testName}`,
      file,
      context: {
        testName,
        error,
      },
    });
  }

  /**
   * 名前重複からトラブルをキャプチャ
   */
  async captureNamingConflict(
    name: string,
    files: string[],
    phase: string
  ): Promise<Trouble | null> {
    return this.capture({
      phase,
      category: "naming-conflict",
      severity: "medium",
      message: `Duplicate name: "${name}" found in multiple files`,
      context: {
        duplicateName: name,
        files,
      },
    });
  }

  /**
   * サイクル終了時に全ての pending トラブルを永続化
   */
  async flush(): Promise<Trouble[]> {
    if (this.pendingTroubles.length === 0) {
      return [];
    }

    await troubleRepository.addBatch(this.pendingTroubles);
    const flushed = [...this.pendingTroubles];
    this.pendingTroubles = [];
    return flushed;
  }

  /**
   * 現在のサイクルで記録されたトラブルを取得
   */
  getPendingTroubles(): Trouble[] {
    return [...this.pendingTroubles];
  }

  /**
   * トラブルを解決済みとしてマーク
   */
  async markResolved(troubleId: string, resolvedBy: string): Promise<void> {
    // pending リストで探す
    const pendingIndex = this.pendingTroubles.findIndex(
      (t) => t.id === troubleId
    );
    if (pendingIndex !== -1) {
      this.pendingTroubles[pendingIndex].resolved = true;
      this.pendingTroubles[pendingIndex].resolvedBy = resolvedBy;
      this.pendingTroubles[pendingIndex].resolvedAt = new Date().toISOString();
      return;
    }

    // リポジトリで探す
    await troubleRepository.resolve(troubleId, resolvedBy);
  }
}

export const troubleCollector = new TroubleCollector();
