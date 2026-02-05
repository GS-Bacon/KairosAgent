/**
 * Trouble Repository - Persistence Layer
 *
 * トラブル履歴をworkspace/troubles.jsonに永続化
 */

import { readFile, writeFile, mkdir } from "fs/promises";
import { existsSync } from "fs";
import { join, dirname } from "path";
import {
  Trouble,
  TroubleFilter,
  TroubleStats,
  TroubleCategory,
  TroubleSeverity,
} from "./types.js";

interface TroubleStore {
  version: number;
  troubles: Trouble[];
  lastUpdated: string;
}

const TROUBLE_FILE = join(process.cwd(), "workspace", "troubles.json");

class TroubleRepository {
  private troubles: Trouble[] = [];
  private loaded: boolean = false;

  async load(): Promise<void> {
    if (this.loaded) return;

    try {
      if (existsSync(TROUBLE_FILE)) {
        const content = await readFile(TROUBLE_FILE, "utf-8");
        const store: TroubleStore = JSON.parse(content);
        this.troubles = store.troubles || [];
      }
    } catch (error) {
      console.warn("Failed to load troubles.json, starting fresh:", error);
      this.troubles = [];
    }

    this.loaded = true;
  }

  async save(): Promise<void> {
    const store: TroubleStore = {
      version: 1,
      troubles: this.troubles,
      lastUpdated: new Date().toISOString(),
    };

    const dir = dirname(TROUBLE_FILE);
    if (!existsSync(dir)) {
      await mkdir(dir, { recursive: true });
    }

    await writeFile(TROUBLE_FILE, JSON.stringify(store, null, 2));
  }

  async add(trouble: Trouble): Promise<void> {
    await this.load();
    this.troubles.push(trouble);
    await this.save();
  }

  async addBatch(troubles: Trouble[]): Promise<void> {
    if (troubles.length === 0) return;
    await this.load();
    this.troubles.push(...troubles);
    await this.save();
  }

  async update(id: string, updates: Partial<Trouble>): Promise<boolean> {
    await this.load();
    const index = this.troubles.findIndex((t) => t.id === id);
    if (index === -1) return false;

    this.troubles[index] = { ...this.troubles[index], ...updates };
    await this.save();
    return true;
  }

  async resolve(id: string, resolvedBy: string): Promise<boolean> {
    return this.update(id, {
      resolved: true,
      resolvedBy,
      resolvedAt: new Date().toISOString(),
    });
  }

  async get(id: string): Promise<Trouble | null> {
    await this.load();
    return this.troubles.find((t) => t.id === id) || null;
  }

  async find(filter: TroubleFilter): Promise<Trouble[]> {
    await this.load();

    return this.troubles.filter((t) => {
      if (filter.cycleId && t.cycleId !== filter.cycleId) return false;
      if (filter.phase && t.phase !== filter.phase) return false;
      if (filter.category && t.category !== filter.category) return false;
      if (filter.severity && t.severity !== filter.severity) return false;
      if (filter.resolved !== undefined && t.resolved !== filter.resolved)
        return false;
      if (filter.file && t.file !== filter.file) return false;
      if (filter.since && t.occurredAt < filter.since) return false;
      if (filter.until && t.occurredAt > filter.until) return false;
      return true;
    });
  }

  async getUnresolved(): Promise<Trouble[]> {
    return this.find({ resolved: false });
  }

  async getRecent(count: number = 50): Promise<Trouble[]> {
    await this.load();
    return [...this.troubles]
      .sort((a, b) => b.occurredAt.localeCompare(a.occurredAt))
      .slice(0, count);
  }

  async findSimilar(trouble: Trouble): Promise<Trouble[]> {
    await this.load();

    return this.troubles.filter((t) => {
      if (t.id === trouble.id) return false;
      // 同じカテゴリ、同じファイル、類似メッセージ
      if (t.category !== trouble.category) return false;
      if (trouble.file && t.file !== trouble.file) return false;
      // メッセージの類似度（簡易チェック）
      const similarity = this.calculateSimilarity(t.message, trouble.message);
      return similarity > 0.5;
    });
  }

  private calculateSimilarity(a: string, b: string): number {
    const wordsA = new Set(a.toLowerCase().split(/\s+/));
    const wordsB = new Set(b.toLowerCase().split(/\s+/));
    const intersection = [...wordsA].filter((w) => wordsB.has(w)).length;
    const union = new Set([...wordsA, ...wordsB]).size;
    return union > 0 ? intersection / union : 0;
  }

  async getStats(): Promise<TroubleStats> {
    await this.load();

    const categories: TroubleCategory[] = [
      "build-error",
      "test-failure",
      "naming-conflict",
      "type-error",
      "runtime-error",
      "lint-error",
      "dependency-error",
      "config-error",
      "security-issue",
      "performance-issue",
      "other",
    ];
    const severities: TroubleSeverity[] = ["low", "medium", "high", "critical"];

    const byCategory = Object.fromEntries(
      categories.map((c) => [c, 0])
    ) as Record<TroubleCategory, number>;

    const bySeverity = Object.fromEntries(
      severities.map((s) => [s, 0])
    ) as Record<TroubleSeverity, number>;

    const byPhase: Record<string, number> = {};

    let resolved = 0;

    for (const t of this.troubles) {
      byCategory[t.category]++;
      bySeverity[t.severity]++;
      byPhase[t.phase] = (byPhase[t.phase] || 0) + 1;
      if (t.resolved) resolved++;
    }

    return {
      total: this.troubles.length,
      resolved,
      unresolved: this.troubles.length - resolved,
      byCategory,
      bySeverity,
      byPhase,
    };
  }

  async clear(): Promise<void> {
    this.troubles = [];
    await this.save();
  }

  getAll(): Trouble[] {
    return [...this.troubles];
  }
}

export const troubleRepository = new TroubleRepository();
