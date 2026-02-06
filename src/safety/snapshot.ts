import { existsSync, mkdirSync, readFileSync, writeFileSync, readdirSync, statSync, unlinkSync, rmdirSync, rmSync, lstatSync, realpathSync } from "fs";
import { join, relative, dirname, resolve } from "path";
import { logger } from "../core/logger.js";

export interface SnapshotStatus {
  count: number;
  maxSnapshots: number;
  isOverLimit: boolean;
  oldestSnapshot?: string;
  newestSnapshot?: string;
}

export interface Snapshot {
  id: string;
  timestamp: Date;
  files: Map<string, string>;
  description?: string;
}

export interface SnapshotInfo {
  id: string;
  timestamp: string;
  fileCount: number;
  description?: string;
}

export class SnapshotManager {
  private snapshotDir: string;
  private srcDir: string;
  private maxSnapshots: number;

  constructor(
    snapshotDir: string = "./workspace/snapshots",
    srcDir: string = "./src",
    maxSnapshots: number = 20
  ) {
    this.snapshotDir = snapshotDir;
    this.srcDir = srcDir;
    this.maxSnapshots = maxSnapshots;
    this.ensureDir();
  }

  private ensureDir(): void {
    if (!existsSync(this.snapshotDir)) {
      mkdirSync(this.snapshotDir, { recursive: true });
    }
  }

  private collectFiles(dir: string, files: Map<string, string> = new Map()): Map<string, string> {
    if (!existsSync(dir)) return files;

    const entries = readdirSync(dir);
    for (const entry of entries) {
      const fullPath = join(dir, entry);
      const stat = statSync(fullPath);

      if (stat.isDirectory()) {
        if (entry !== "node_modules" && entry !== ".git") {
          this.collectFiles(fullPath, files);
        }
      } else if (entry.endsWith(".ts") || entry.endsWith(".json")) {
        const relativePath = relative(this.srcDir, fullPath);
        files.set(relativePath, readFileSync(fullPath, "utf-8"));
      }
    }
    return files;
  }

  create(description?: string): string {
    const id = `snap_${Date.now()}`;
    const snapshotPath = join(this.snapshotDir, id);
    mkdirSync(snapshotPath, { recursive: true });

    const files = this.collectFiles(this.srcDir);

    for (const [relativePath, content] of files) {
      const targetPath = join(snapshotPath, relativePath);
      const targetDir = dirname(targetPath);
      if (!existsSync(targetDir)) {
        mkdirSync(targetDir, { recursive: true });
      }
      writeFileSync(targetPath, content);
    }

    const meta = {
      id,
      timestamp: new Date().toISOString(),
      fileCount: files.size,
      description,
    };
    writeFileSync(join(snapshotPath, "meta.json"), JSON.stringify(meta, null, 2));

    logger.info("Created snapshot", { id, fileCount: files.size });

    this.cleanup();
    return id;
  }

  restore(id: string): boolean {
    // IDにパストラバーサルが含まれていないか検証
    if (id.includes("..") || id.includes("/") || id.includes("\\")) {
      logger.error("Invalid snapshot ID (path traversal attempt)", { id });
      return false;
    }

    const snapshotPath = join(this.snapshotDir, id);

    // resolvedPathがsnapshotDir内か検証
    const resolvedSnapshotDir = resolve(this.snapshotDir);
    const resolvedSnapshotPath = resolve(snapshotPath);
    if (!resolvedSnapshotPath.startsWith(resolvedSnapshotDir + "/")) {
      logger.error("Snapshot path traversal blocked", {
        id,
        resolvedPath: resolvedSnapshotPath,
        expectedPrefix: resolvedSnapshotDir,
      });
      return false;
    }

    if (!existsSync(snapshotPath)) {
      logger.error("Snapshot not found", { id });
      return false;
    }

    // シンボリックリンクチェック
    try {
      const stat = lstatSync(snapshotPath);
      if (stat.isSymbolicLink()) {
        logger.error("Snapshot is a symbolic link (blocked)", { id });
        return false;
      }
    } catch {
      logger.error("Failed to stat snapshot", { id });
      return false;
    }

    const metaPath = join(snapshotPath, "meta.json");
    if (!existsSync(metaPath)) {
      logger.error("Invalid snapshot (no meta.json)", { id });
      return false;
    }

    const files = this.collectFilesFromSnapshot(snapshotPath);

    const resolvedSrcDir = resolve(this.srcDir);
    for (const [relativePath, content] of files) {
      const targetPath = join(this.srcDir, relativePath);
      // 復元先がsrcDir内か検証
      const resolvedTarget = resolve(targetPath);
      if (!resolvedTarget.startsWith(resolvedSrcDir + "/")) {
        logger.error("Restore target path traversal blocked", {
          relativePath,
          resolvedTarget,
        });
        continue;
      }
      const targetDir = dirname(targetPath);
      if (!existsSync(targetDir)) {
        mkdirSync(targetDir, { recursive: true });
      }
      writeFileSync(targetPath, content);
    }

    logger.info("Restored snapshot", { id, fileCount: files.size });
    return true;
  }

  private collectFilesFromSnapshot(
    dir: string,
    files: Map<string, string> = new Map(),
    base?: string
  ): Map<string, string> {
    const baseDir = base || dir;
    const entries = readdirSync(dir);

    for (const entry of entries) {
      if (entry === "meta.json") continue;

      const fullPath = join(dir, entry);
      const stat = statSync(fullPath);

      if (stat.isDirectory()) {
        this.collectFilesFromSnapshot(fullPath, files, baseDir);
      } else {
        const relativePath = relative(baseDir, fullPath);
        files.set(relativePath, readFileSync(fullPath, "utf-8"));
      }
    }
    return files;
  }

  list(): SnapshotInfo[] {
    if (!existsSync(this.snapshotDir)) return [];

    const entries = readdirSync(this.snapshotDir);
    const snapshots: SnapshotInfo[] = [];

    for (const entry of entries) {
      const metaPath = join(this.snapshotDir, entry, "meta.json");
      if (existsSync(metaPath)) {
        try {
          const meta = JSON.parse(readFileSync(metaPath, "utf-8"));
          snapshots.push(meta);
        } catch {
          // Skip invalid snapshots
        }
      }
    }

    return snapshots.sort(
      (a, b) => new Date(b.timestamp).getTime() - new Date(a.timestamp).getTime()
    );
  }

  private cleanup(): void {
    const snapshots = this.list();
    if (snapshots.length <= this.maxSnapshots) return;

    const toDelete = snapshots.slice(this.maxSnapshots);
    for (const snap of toDelete) {
      const snapshotPath = join(this.snapshotDir, snap.id);
      try {
        // シンボリックリンクチェック
        const stat = lstatSync(snapshotPath);
        if (stat.isSymbolicLink()) {
          logger.warn("Skipping symbolic link during cleanup", { id: snap.id });
          continue;
        }
        this.deleteDir(snapshotPath);
        logger.info("Deleted old snapshot", { id: snap.id });
      } catch (err) {
        logger.warn("Failed to delete snapshot during cleanup", {
          id: snap.id,
          error: err instanceof Error ? err.message : String(err),
        });
      }
    }
  }

  private deleteDir(dir: string): void {
    if (!existsSync(dir)) return;

    const entries = readdirSync(dir);
    for (const entry of entries) {
      const fullPath = join(dir, entry);
      const stat = statSync(fullPath);
      if (stat.isDirectory()) {
        this.deleteDir(fullPath);
      } else {
        unlinkSync(fullPath);
      }
    }
    rmdirSync(dir);
  }

  /**
   * スナップショット数と状態を取得
   */
  getStatus(): SnapshotStatus {
    const snapshots = this.list();
    const count = snapshots.length;

    return {
      count,
      maxSnapshots: this.maxSnapshots,
      isOverLimit: count > this.maxSnapshots,
      oldestSnapshot: snapshots[snapshots.length - 1]?.id,
      newestSnapshot: snapshots[0]?.id,
    };
  }

  /**
   * 強制クリーンアップ（通常の削除が失敗した場合のフォールバック）
   */
  forceCleanup(): { success: boolean; deleted: number; errors: string[] } {
    const snapshots = this.list();
    const errors: string[] = [];
    let deleted = 0;

    if (snapshots.length <= this.maxSnapshots) {
      return { success: true, deleted: 0, errors: [] };
    }

    const toDelete = snapshots.slice(this.maxSnapshots);

    for (const snap of toDelete) {
      const snapshotPath = join(this.snapshotDir, snap.id);

      try {
        this.deleteDir(snapshotPath);
        deleted++;
        logger.info("Force deleted snapshot", { id: snap.id });
      } catch (err1) {
        try {
          rmSync(snapshotPath, { recursive: true, force: true });
          deleted++;
          logger.info("Force deleted snapshot (rmSync fallback)", { id: snap.id });
        } catch (err2) {
          const errorMsg = `Failed to delete ${snap.id}: ${err2 instanceof Error ? err2.message : String(err2)}`;
          errors.push(errorMsg);
          logger.error("Force cleanup failed for snapshot", {
            id: snap.id,
            error: errorMsg,
          });
        }
      }
    }

    const success = errors.length === 0;
    if (success) {
      logger.info("Force cleanup completed", { deleted });
    } else {
      logger.warn("Force cleanup completed with errors", { deleted, errors });
    }

    return { success, deleted, errors };
  }

  /**
   * 全てのスナップショットを削除（緊急用）
   */
  clearAll(): { success: boolean; deleted: number; errors: string[] } {
    const snapshots = this.list();
    const errors: string[] = [];
    let deleted = 0;

    for (const snap of snapshots) {
      const snapshotPath = join(this.snapshotDir, snap.id);
      try {
        rmSync(snapshotPath, { recursive: true, force: true });
        deleted++;
      } catch (err) {
        errors.push(`${snap.id}: ${err instanceof Error ? err.message : String(err)}`);
      }
    }

    return { success: errors.length === 0, deleted, errors };
  }
}

export const snapshotManager = new SnapshotManager();
