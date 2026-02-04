import {
  getLogger,
  generateId,
  type Suggestion,
  type SuggestionCategory,
  type SuggestionPriority,
  type SuggestionStatus,
  type SuggestionSystemResponse,
} from '@auto-claude/core';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'fs';
import { dirname, join } from 'path';

const logger = getLogger('suggestion-gate');

export interface SuggestionGateConfig {
  suggestionsDir: string;
}

export interface CreateSuggestionInput {
  title: string;
  content: string;
  category: SuggestionCategory;
  priority: SuggestionPriority;
}

export class SuggestionGate {
  private config: SuggestionGateConfig;
  private pendingFile: string;
  private processedFile: string;

  constructor(config: Partial<SuggestionGateConfig> = {}) {
    this.config = {
      suggestionsDir: config.suggestionsDir ?? '/home/bacon/AutoClaudeKMP/workspace/suggestions',
    };

    this.pendingFile = join(this.config.suggestionsDir, 'pending.json');
    this.processedFile = join(this.config.suggestionsDir, 'processed.json');

    this.ensureDirectories();
    logger.info('SuggestionGate initialized', { suggestionsDir: this.config.suggestionsDir });
  }

  private ensureDirectories(): void {
    if (!existsSync(this.config.suggestionsDir)) {
      mkdirSync(this.config.suggestionsDir, { recursive: true });
    }

    const historyDir = join(this.config.suggestionsDir, 'history');
    if (!existsSync(historyDir)) {
      mkdirSync(historyDir, { recursive: true });
    }

    // 初期ファイルがなければ作成
    if (!existsSync(this.pendingFile)) {
      writeFileSync(this.pendingFile, '[]', 'utf-8');
    }
    if (!existsSync(this.processedFile)) {
      writeFileSync(this.processedFile, '[]', 'utf-8');
    }
  }

  private readPending(): Suggestion[] {
    try {
      const content = readFileSync(this.pendingFile, 'utf-8');
      const suggestions = JSON.parse(content) as Suggestion[];
      return suggestions.map((s) => ({
        ...s,
        createdAt: new Date(s.createdAt),
        systemResponse: s.systemResponse
          ? { ...s.systemResponse, respondedAt: new Date(s.systemResponse.respondedAt) }
          : undefined,
      }));
    } catch (error) {
      logger.error('Failed to read pending suggestions', { error });
      return [];
    }
  }

  private writePending(suggestions: Suggestion[]): void {
    try {
      writeFileSync(this.pendingFile, JSON.stringify(suggestions, null, 2), 'utf-8');
    } catch (error) {
      logger.error('Failed to write pending suggestions', { error });
    }
  }

  private readProcessed(): Suggestion[] {
    try {
      const content = readFileSync(this.processedFile, 'utf-8');
      const suggestions = JSON.parse(content) as Suggestion[];
      return suggestions.map((s) => ({
        ...s,
        createdAt: new Date(s.createdAt),
        systemResponse: s.systemResponse
          ? { ...s.systemResponse, respondedAt: new Date(s.systemResponse.respondedAt) }
          : undefined,
      }));
    } catch (error) {
      logger.error('Failed to read processed suggestions', { error });
      return [];
    }
  }

  private writeProcessed(suggestions: Suggestion[]): void {
    try {
      writeFileSync(this.processedFile, JSON.stringify(suggestions, null, 2), 'utf-8');
    } catch (error) {
      logger.error('Failed to write processed suggestions', { error });
    }
  }

  create(input: CreateSuggestionInput): Suggestion {
    const suggestion: Suggestion = {
      id: generateId('sug'),
      title: input.title,
      content: input.content,
      category: input.category,
      priority: input.priority,
      status: 'pending',
      createdAt: new Date(),
    };

    const pending = this.readPending();
    pending.push(suggestion);
    this.writePending(pending);

    logger.info('Suggestion created', { id: suggestion.id, title: suggestion.title });
    return suggestion;
  }

  getPending(): Suggestion[] {
    return this.readPending().filter((s) => s.status === 'pending');
  }

  getAll(): Suggestion[] {
    const pending = this.readPending();
    const processed = this.readProcessed();
    return [...pending, ...processed].sort(
      (a, b) => new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime()
    );
  }

  getById(id: string): Suggestion | null {
    const pending = this.readPending();
    const found = pending.find((s) => s.id === id);
    if (found) return found;

    const processed = this.readProcessed();
    return processed.find((s) => s.id === id) ?? null;
  }

  respond(
    id: string,
    response: Omit<SuggestionSystemResponse, 'respondedAt'>,
    newStatus: SuggestionStatus
  ): boolean {
    const pending = this.readPending();
    const index = pending.findIndex((s) => s.id === id);

    if (index === -1) {
      logger.warn('Suggestion not found in pending', { id });
      return false;
    }

    const suggestion = pending[index];
    suggestion.status = newStatus;
    suggestion.systemResponse = {
      ...response,
      respondedAt: new Date(),
    };

    // pendingから削除してprocessedに移動
    pending.splice(index, 1);
    this.writePending(pending);

    const processed = this.readProcessed();
    processed.push(suggestion);
    this.writeProcessed(processed);

    // 月別履歴にも保存
    this.archiveToHistory(suggestion);

    logger.info('Suggestion responded', { id, status: newStatus });
    return true;
  }

  private archiveToHistory(suggestion: Suggestion): void {
    const monthKey = new Date().toISOString().slice(0, 7); // YYYY-MM
    const historyFile = join(this.config.suggestionsDir, 'history', `${monthKey}.json`);

    let history: Suggestion[] = [];
    if (existsSync(historyFile)) {
      try {
        history = JSON.parse(readFileSync(historyFile, 'utf-8'));
      } catch {
        history = [];
      }
    }

    history.push(suggestion);
    writeFileSync(historyFile, JSON.stringify(history, null, 2), 'utf-8');
  }

  updateStatus(id: string, status: SuggestionStatus): boolean {
    const pending = this.readPending();
    const index = pending.findIndex((s) => s.id === id);

    if (index !== -1) {
      pending[index].status = status;
      this.writePending(pending);
      return true;
    }

    const processed = this.readProcessed();
    const procIndex = processed.findIndex((s) => s.id === id);

    if (procIndex !== -1) {
      processed[procIndex].status = status;
      this.writeProcessed(processed);
      return true;
    }

    return false;
  }
}

let instance: SuggestionGate | null = null;

export function getSuggestionGate(config?: Partial<SuggestionGateConfig>): SuggestionGate {
  if (!instance) {
    instance = new SuggestionGate(config);
  }
  return instance;
}
