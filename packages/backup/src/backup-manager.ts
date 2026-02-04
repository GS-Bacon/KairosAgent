import { getLogger, formatDate, generateId } from '@auto-claude/core';
import { existsSync, mkdirSync, readdirSync, rmSync, statSync } from 'fs';
import { join, basename } from 'path';
import { execSync } from 'child_process';

const logger = getLogger('backup');

export interface BackupConfig {
  backupDir: string;
  maxBackups: number;
  compressionEnabled: boolean;
}

export interface BackupInfo {
  id: string;
  timestamp: Date;
  path: string;
  size: number;
  type: 'daily' | 'restore_point';
  reason?: string;
}

export interface RestorePoint {
  id: string;
  timestamp: Date;
  reason: string;
  path: string;
}

export class BackupManager {
  private config: BackupConfig;
  private restorePoints: Map<string, RestorePoint> = new Map();

  constructor(config: Partial<BackupConfig> = {}) {
    this.config = {
      backupDir: config.backupDir ?? '/home/bacon/AutoClaudeKMP/backups',
      maxBackups: config.maxBackups ?? 7,
      compressionEnabled: config.compressionEnabled ?? true,
    };

    this.ensureBackupDir();
    logger.info('BackupManager initialized', {
      backupDir: this.config.backupDir,
      maxBackups: this.config.maxBackups,
    });
  }

  private ensureBackupDir(): void {
    if (!existsSync(this.config.backupDir)) {
      mkdirSync(this.config.backupDir, { recursive: true });
    }
  }

  async dailyBackup(): Promise<BackupInfo> {
    const timestamp = formatDate(new Date());
    const backupPath = join(this.config.backupDir, `daily-${timestamp}`);

    logger.info('Starting daily backup', { path: backupPath });

    // バックアップ対象のディレクトリ
    const targets = [
      '/home/bacon/AutoClaudeKMP/workspace/MEMORY.md',
      '/home/bacon/AutoClaudeKMP/workspace/ledger',
      '/home/bacon/AutoClaudeKMP/workspace/strategies',
      '/home/bacon/AutoClaudeKMP/auth',
    ];

    await this.backup(targets, backupPath);
    await this.rotateBackups();

    const size = this.getDirectorySize(backupPath);

    const info: BackupInfo = {
      id: `daily-${timestamp}`,
      timestamp: new Date(),
      path: backupPath,
      size,
      type: 'daily',
    };

    logger.info('Daily backup completed', info);
    return info;
  }

  async createRestorePoint(reason: string): Promise<RestorePoint> {
    const pointId = `restore-${Date.now()}`;
    const backupPath = join(this.config.backupDir, pointId);

    logger.info('Creating restore point', { pointId, reason });

    const targets = [
      '/home/bacon/AutoClaudeKMP/workspace',
      '/home/bacon/AutoClaudeKMP/auth',
    ];

    await this.backup(targets, backupPath);

    const restorePoint: RestorePoint = {
      id: pointId,
      timestamp: new Date(),
      reason,
      path: backupPath,
    };

    this.restorePoints.set(pointId, restorePoint);
    this.saveRestorePointIndex();

    logger.info('Restore point created', restorePoint);
    return restorePoint;
  }

  async restore(pointId: string): Promise<void> {
    const restorePoint = this.restorePoints.get(pointId);

    if (!restorePoint) {
      // ディレクトリから探す
      const backupPath = join(this.config.backupDir, pointId);
      if (!existsSync(backupPath)) {
        throw new Error(`Restore point not found: ${pointId}`);
      }
    }

    const backupPath = restorePoint?.path ?? join(this.config.backupDir, pointId);

    logger.warn('Starting restore', { pointId, backupPath });

    // workspace を復元
    const workspaceBackup = join(backupPath, 'workspace');
    if (existsSync(workspaceBackup)) {
      execSync(`cp -r ${workspaceBackup}/* /home/bacon/AutoClaudeKMP/workspace/`, {
        stdio: 'inherit',
      });
    }

    // auth を復元
    const authBackup = join(backupPath, 'auth');
    if (existsSync(authBackup)) {
      execSync(`cp -r ${authBackup}/* /home/bacon/AutoClaudeKMP/auth/`, {
        stdio: 'inherit',
      });
    }

    logger.info('Restore completed', { pointId });
  }

  private async backup(sources: string[], destDir: string): Promise<void> {
    if (!existsSync(destDir)) {
      mkdirSync(destDir, { recursive: true });
    }

    for (const source of sources) {
      if (!existsSync(source)) {
        logger.warn('Backup source not found', { source });
        continue;
      }

      const destName = basename(source);
      const dest = join(destDir, destName);

      try {
        if (statSync(source).isDirectory()) {
          execSync(`cp -r "${source}" "${dest}"`, { stdio: 'pipe' });
        } else {
          execSync(`cp "${source}" "${dest}"`, { stdio: 'pipe' });
        }
      } catch (error) {
        logger.error('Failed to backup', { source, error });
      }
    }

    // 圧縮が有効な場合
    if (this.config.compressionEnabled) {
      try {
        const tarFile = `${destDir}.tar.gz`;
        execSync(`tar -czf "${tarFile}" -C "${this.config.backupDir}" "${basename(destDir)}"`, {
          stdio: 'pipe',
        });
        rmSync(destDir, { recursive: true, force: true });
        mkdirSync(destDir, { recursive: true });
        execSync(`mv "${tarFile}" "${destDir}/"`, { stdio: 'pipe' });
      } catch (error) {
        logger.warn('Compression failed, keeping uncompressed backup', { error });
      }
    }
  }

  private async rotateBackups(): Promise<void> {
    const entries = readdirSync(this.config.backupDir)
      .filter((name) => name.startsWith('daily-'))
      .map((name) => ({
        name,
        path: join(this.config.backupDir, name),
        time: statSync(join(this.config.backupDir, name)).mtime.getTime(),
      }))
      .sort((a, b) => b.time - a.time);

    // 古いバックアップを削除
    const toDelete = entries.slice(this.config.maxBackups);

    for (const entry of toDelete) {
      logger.info('Removing old backup', { name: entry.name });
      rmSync(entry.path, { recursive: true, force: true });
    }
  }

  private getDirectorySize(dir: string): number {
    try {
      const output = execSync(`du -sb "${dir}" 2>/dev/null | cut -f1`, {
        encoding: 'utf-8',
      });
      return parseInt(output.trim(), 10) || 0;
    } catch {
      return 0;
    }
  }

  private saveRestorePointIndex(): void {
    const indexPath = join(this.config.backupDir, 'restore-points.json');
    const data = Array.from(this.restorePoints.values());

    try {
      const { writeFileSync } = require('fs');
      writeFileSync(indexPath, JSON.stringify(data, null, 2), 'utf-8');
    } catch (error) {
      logger.error('Failed to save restore point index', { error });
    }
  }

  listBackups(): BackupInfo[] {
    const entries = readdirSync(this.config.backupDir)
      .filter((name) => name.startsWith('daily-') || name.startsWith('restore-'))
      .map((name) => {
        const path = join(this.config.backupDir, name);
        const stat = statSync(path);

        return {
          id: name,
          timestamp: stat.mtime,
          path,
          size: this.getDirectorySize(path),
          type: name.startsWith('daily-') ? 'daily' : 'restore_point',
        } as BackupInfo;
      })
      .sort((a, b) => b.timestamp.getTime() - a.timestamp.getTime());

    return entries;
  }

  listRestorePoints(): RestorePoint[] {
    return Array.from(this.restorePoints.values())
      .sort((a, b) => b.timestamp.getTime() - a.timestamp.getTime());
  }

  deleteBackup(id: string): void {
    const path = join(this.config.backupDir, id);

    if (!existsSync(path)) {
      throw new Error(`Backup not found: ${id}`);
    }

    rmSync(path, { recursive: true, force: true });
    this.restorePoints.delete(id);
    this.saveRestorePointIndex();

    logger.info('Backup deleted', { id });
  }
}

let instance: BackupManager | null = null;

export function getBackupManager(config?: Partial<BackupConfig>): BackupManager {
  if (!instance) {
    instance = new BackupManager(config);
  }
  return instance;
}
