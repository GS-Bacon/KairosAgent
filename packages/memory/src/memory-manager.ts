import { getLogger, formatDateTime } from '@auto-claude/core';
import { readFileSync, writeFileSync, existsSync, mkdirSync, readdirSync } from 'fs';
import { join, dirname } from 'path';

const logger = getLogger('memory');

export interface MemoryConfig {
  workspaceDir: string;
  maxMemoryFileSizeMB: number;
}

export interface MemoryEntry {
  key: string;
  value: unknown;
  timestamp: Date;
  category?: string;
  tags?: string[];
}

export interface LearningEntry {
  id: string;
  timestamp: Date;
  type: 'success' | 'failure' | 'insight';
  category: string;
  description: string;
  context?: Record<string, unknown>;
  actionTaken?: string;
  outcome?: string;
}

export class MemoryManager {
  private config: MemoryConfig;
  private cache: Map<string, unknown> = new Map();

  constructor(config: Partial<MemoryConfig> = {}) {
    this.config = {
      workspaceDir: config.workspaceDir ?? '/home/bacon/AutoClaudeKMP/workspace',
      maxMemoryFileSizeMB: config.maxMemoryFileSizeMB ?? 10,
    };

    this.ensureDirectories();
    logger.info('MemoryManager initialized', { workspaceDir: this.config.workspaceDir });
  }

  private ensureDirectories(): void {
    const dirs = [
      this.config.workspaceDir,
      join(this.config.workspaceDir, 'memory'),
    ];

    for (const dir of dirs) {
      if (!existsSync(dir)) {
        mkdirSync(dir, { recursive: true });
      }
    }
  }

  private getMemoryPath(filename: string): string {
    return join(this.config.workspaceDir, filename);
  }

  async read(filename: string): Promise<string | null> {
    const path = this.getMemoryPath(filename);

    if (!existsSync(path)) {
      return null;
    }

    try {
      return readFileSync(path, 'utf-8');
    } catch (error) {
      logger.error('Failed to read memory file', { filename, error });
      return null;
    }
  }

  async write(filename: string, content: string | object): Promise<void> {
    const path = this.getMemoryPath(filename);
    const dir = dirname(path);

    if (!existsSync(dir)) {
      mkdirSync(dir, { recursive: true });
    }

    const data = typeof content === 'string' ? content : JSON.stringify(content, null, 2);

    try {
      writeFileSync(path, data, 'utf-8');
      logger.debug('Memory file written', { filename });
    } catch (error) {
      logger.error('Failed to write memory file', { filename, error });
      throw error;
    }
  }

  async append(filename: string, content: string): Promise<void> {
    const existing = await this.read(filename);
    const newContent = existing ? `${existing}\n${content}` : content;
    await this.write(filename, newContent);
  }

  async readJson<T>(filename: string): Promise<T | null> {
    const content = await this.read(filename);

    if (!content) {
      return null;
    }

    try {
      return JSON.parse(content) as T;
    } catch (error) {
      logger.error('Failed to parse JSON', { filename, error });
      return null;
    }
  }

  async writeJson<T>(filename: string, data: T): Promise<void> {
    await this.write(filename, JSON.stringify(data, null, 2));
  }

  // キー・バリューストア
  set(key: string, value: unknown): void {
    this.cache.set(key, value);
  }

  get<T>(key: string): T | undefined {
    return this.cache.get(key) as T | undefined;
  }

  delete(key: string): boolean {
    return this.cache.delete(key);
  }

  has(key: string): boolean {
    return this.cache.has(key);
  }

  // 学習記録
  async recordLearning(entry: Omit<LearningEntry, 'id' | 'timestamp'>): Promise<void> {
    const fullEntry: LearningEntry = {
      ...entry,
      id: `learning_${Date.now()}`,
      timestamp: new Date(),
    };

    const filename = 'LEARNINGS.md';
    const line = this.formatLearningEntry(fullEntry);

    await this.append(filename, line);
    logger.info('Learning recorded', { type: entry.type, category: entry.category });
  }

  private formatLearningEntry(entry: LearningEntry): string {
    const icon = entry.type === 'success' ? '✅' : entry.type === 'failure' ? '❌' : '💡';
    const time = formatDateTime(entry.timestamp);

    let text = `\n## ${icon} ${entry.category} - ${time}\n`;
    text += `\n${entry.description}\n`;

    if (entry.actionTaken) {
      text += `\n**対応:** ${entry.actionTaken}\n`;
    }

    if (entry.outcome) {
      text += `\n**結果:** ${entry.outcome}\n`;
    }

    return text;
  }

  async getLearnings(): Promise<string> {
    return (await this.read('LEARNINGS.md')) ?? '';
  }

  // エラー履歴
  async recordError(error: {
    message: string;
    stack?: string;
    context?: Record<string, unknown>;
  }): Promise<void> {
    const filename = 'ERROR_HISTORY.md';
    const time = formatDateTime(new Date());

    let line = `\n## ❌ ${time}\n`;
    line += `\n**エラー:** ${error.message}\n`;

    if (error.stack) {
      line += `\n\`\`\`\n${error.stack}\n\`\`\`\n`;
    }

    if (error.context) {
      line += `\n**コンテキスト:**\n\`\`\`json\n${JSON.stringify(error.context, null, 2)}\n\`\`\`\n`;
    }

    await this.append(filename, line);
  }

  // コスト履歴
  async recordCost(entry: {
    type: string;
    amount: number;
    tokens?: number;
    model?: string;
    description?: string;
  }): Promise<void> {
    const filename = 'COST_HISTORY.md';
    const time = formatDateTime(new Date());

    let line = `| ${time} | ${entry.type} | ¥${entry.amount} |`;

    if (entry.tokens) {
      line += ` ${entry.tokens} tokens |`;
    }

    if (entry.model) {
      line += ` ${entry.model} |`;
    }

    if (entry.description) {
      line += ` ${entry.description} |`;
    }

    line += '\n';

    await this.append(filename, line);
  }

  // リスクログ
  async recordRisk(entry: {
    level: number;
    category: string;
    description: string;
    action: string;
    outcome: string;
  }): Promise<void> {
    const filename = 'RISK_LOG.md';
    const time = formatDateTime(new Date());
    const levelNames = ['LOW', 'MEDIUM', 'HIGH', 'CRITICAL'];

    let line = `\n## ${levelNames[entry.level - 1]} - ${entry.category} - ${time}\n`;
    line += `\n${entry.description}\n`;
    line += `\n**対応:** ${entry.action}\n`;
    line += `\n**結果:** ${entry.outcome}\n`;

    await this.append(filename, line);
  }

  // メインメモリファイルの更新
  async updateMainMemory(content: string): Promise<void> {
    await this.write('MEMORY.md', content);
  }

  async getMainMemory(): Promise<string> {
    return (await this.read('MEMORY.md')) ?? '';
  }

  listFiles(subdir?: string): string[] {
    const dir = subdir
      ? join(this.config.workspaceDir, subdir)
      : this.config.workspaceDir;

    if (!existsSync(dir)) {
      return [];
    }

    try {
      return readdirSync(dir);
    } catch (error) {
      logger.error('Failed to list files', { dir, error });
      return [];
    }
  }
}

let instance: MemoryManager | null = null;

export function getMemoryManager(config?: Partial<MemoryConfig>): MemoryManager {
  if (!instance) {
    instance = new MemoryManager(config);
  }
  return instance;
}
