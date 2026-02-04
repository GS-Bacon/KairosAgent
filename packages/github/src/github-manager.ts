import { getLogger } from '@auto-claude/core';
import { getDiscordNotifier } from '@auto-claude/notification';
import { execSync } from 'child_process';
import { readFileSync, writeFileSync, existsSync } from 'fs';
import { join } from 'path';

const logger = getLogger('github');

export interface GitHubConfig {
  repoPath: string;
  remoteName: string;
  mainBranch: string;
}

export interface PublicStats {
  uptimeDays: number;
  strategiesActive: number;
  systemHealth: 'healthy' | 'degraded' | 'offline';
  profitStatus: 'profitable' | 'breakeven' | 'loss';
  lastUpdate: string;
}

export class GitHubManager {
  private config: GitHubConfig;
  private discord = getDiscordNotifier();

  private secretPatterns = [
    '.env',
    '.env.*',
    'auth/',
    '*.key',
    '*.pem',
    '*credentials*',
    '*secret*',
    'workspace/ledger/',
    'workspace/audit/',
    'backups/',
  ];

  constructor(config: Partial<GitHubConfig> = {}) {
    this.config = {
      repoPath: config.repoPath ?? '/home/bacon/AutoClaudeKMP',
      remoteName: config.remoteName ?? 'origin',
      mainBranch: config.mainBranch ?? 'main',
    };
    logger.info('GitHubManager initialized', { repoPath: this.config.repoPath });
  }

  async ensureGitignore(): Promise<void> {
    const gitignorePath = join(this.config.repoPath, '.gitignore');

    let content = '';
    if (existsSync(gitignorePath)) {
      content = readFileSync(gitignorePath, 'utf-8');
    }

    const missing = this.secretPatterns.filter((p) => !content.includes(p));

    if (missing.length > 0) {
      content += '\n# Auto-added by GitHubManager\n';
      content += missing.join('\n') + '\n';
      writeFileSync(gitignorePath, content, 'utf-8');
      logger.info('Updated .gitignore', { added: missing });
    }
  }

  async safePush(message: string): Promise<boolean> {
    // 1. 機密ファイルのチェック
    const stagedFiles = this.getStagedFiles();
    const secretFiles = this.detectSecrets(stagedFiles);

    if (secretFiles.length > 0) {
      await this.discord.sendWarning(
        '機密ファイル検出',
        `以下のファイルは公開できません:\n${secretFiles.join('\n')}`
      );
      logger.error('Secret files detected in staging', { files: secretFiles });
      return false;
    }

    try {
      // 2. コミット
      execSync(`git commit -m "${message.replace(/"/g, '\\"')}"`, {
        cwd: this.config.repoPath,
        stdio: 'pipe',
      });

      // 3. プッシュ
      execSync(`git push ${this.config.remoteName} ${this.config.mainBranch}`, {
        cwd: this.config.repoPath,
        stdio: 'pipe',
      });

      await this.discord.sendSuccess('GitHub更新', message);
      logger.info('Push successful', { message });
      return true;
    } catch (error) {
      logger.error('Push failed', { error });
      return false;
    }
  }

  private getStagedFiles(): string[] {
    try {
      const output = execSync('git diff --cached --name-only', {
        cwd: this.config.repoPath,
        encoding: 'utf-8',
      });
      return output.trim().split('\n').filter(Boolean);
    } catch {
      return [];
    }
  }

  private detectSecrets(files: string[]): string[] {
    const secrets: string[] = [];

    for (const file of files) {
      for (const pattern of this.secretPatterns) {
        const regex = new RegExp(
          pattern
            .replace(/\./g, '\\.')
            .replace(/\*/g, '.*')
            .replace(/\//g, '\\/'),
          'i'
        );

        if (regex.test(file)) {
          secrets.push(file);
          break;
        }
      }
    }

    return secrets;
  }

  async updateReadme(stats: PublicStats): Promise<void> {
    const readmePath = join(this.config.repoPath, 'README.md');

    const readme = this.generateReadme(stats);

    // 機密情報を含まないか確認
    if (this.containsSecrets(readme)) {
      logger.error('README contains secrets');
      throw new Error('README contains secrets');
    }

    writeFileSync(readmePath, readme, 'utf-8');

    // 変更をステージング
    execSync('git add README.md', {
      cwd: this.config.repoPath,
      stdio: 'pipe',
    });

    logger.info('README updated');
  }

  private generateReadme(stats: PublicStats): string {
    const healthEmoji = {
      healthy: '🟢',
      degraded: '🟡',
      offline: '🔴',
    };

    const profitEmoji = {
      profitable: '📈',
      breakeven: '➡️',
      loss: '📉',
    };

    return `# AutoClaudeKMP

AIが自律的に収益を稼ぎ、自己改善を続けるシステム

## ステータス

| 指標 | 状態 |
|------|------|
| システム健全性 | ${healthEmoji[stats.systemHealth]} ${stats.systemHealth} |
| 稼働日数 | ${stats.uptimeDays} 日 |
| アクティブ戦略 | ${stats.strategiesActive} 件 |
| 収益状況 | ${profitEmoji[stats.profitStatus]} ${stats.profitStatus} |

最終更新: ${stats.lastUpdate}

## 概要

このプロジェクトは、AIが自律的に以下を行うシステムです：

- 収益化方法の調査・選定・実行
- 問題発生時の根本原因分析
- プロセスの自己改善
- 継続的な学習と最適化

## アーキテクチャ

\`\`\`
Orchestrator → Task Queue → Claude Code CLI
      ↓
Safety & Compliance
      ↓
Self-Improvement Engine
\`\`\`

## ライセンス

Private - All rights reserved

---

*このREADMEは自動生成されています*
`;
  }

  private containsSecrets(content: string): boolean {
    const secretPatterns = [
      /api[_-]?key/i,
      /secret[_-]?key/i,
      /password/i,
      /bearer\s+[a-zA-Z0-9]/i,
      /sk-[a-zA-Z0-9]{20,}/,
      /ghp_[a-zA-Z0-9]{36}/,
    ];

    return secretPatterns.some((pattern) => pattern.test(content));
  }

  async getUptimeDays(): Promise<number> {
    try {
      const output = execSync(
        'git log --reverse --format=%ct | head -1',
        {
          cwd: this.config.repoPath,
          encoding: 'utf-8',
        }
      );
      const firstCommit = parseInt(output.trim(), 10) * 1000;
      const now = Date.now();
      return Math.floor((now - firstCommit) / (1000 * 60 * 60 * 24));
    } catch {
      return 0;
    }
  }

  async getCurrentBranch(): Promise<string> {
    try {
      return execSync('git branch --show-current', {
        cwd: this.config.repoPath,
        encoding: 'utf-8',
      }).trim();
    } catch {
      return 'unknown';
    }
  }

  async hasUncommittedChanges(): Promise<boolean> {
    try {
      const output = execSync('git status --porcelain', {
        cwd: this.config.repoPath,
        encoding: 'utf-8',
      });
      return output.trim().length > 0;
    } catch {
      return false;
    }
  }
}

let instance: GitHubManager | null = null;

export function getGitHubManager(config?: Partial<GitHubConfig>): GitHubManager {
  if (!instance) {
    instance = new GitHubManager(config);
  }
  return instance;
}
