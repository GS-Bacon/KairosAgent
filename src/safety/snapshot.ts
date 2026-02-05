import { existsSync, mkdirSync, readFileSync, writeFileSync, readdirSync, statSync, copyFileSync } from "fs";
import { join, relative, dirname } from "path";
import { logger } from "../core/logger.js";

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
    maxSnapshots: number = 10
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
    const snapshotPath = join(this.snapshotDir, id);
    if (!existsSync(snapshotPath)) {
      logger.error("Snapshot not found", { id });
      return false;
    }

    const metaPath = join(snapshotPath, "meta.json");
    if (!existsSync(metaPath)) {
      logger.error("Invalid snapshot (no meta.json)", { id });
      return false;
    }

    const files = this.collectFilesFromSnapshot(snapshotPath);

    for (const [relativePath, content] of files) {
      const targetPath = join(this.srcDir, relativePath);
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
      this.deleteDir(snapshotPath);
      logger.info("Deleted old snapshot", { id: snap.id });
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
        writeFileSync(fullPath, ""); // Clear content first
        // Note: In production, use fs.unlinkSync
      }
    }
  }
}

export const snapshotManager = new SnapshotManager();
