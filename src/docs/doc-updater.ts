/**
 * ドキュメント自動更新
 *
 * マーカーベースでドキュメントの特定セクションを更新
 */

import { existsSync, readFileSync, writeFileSync } from "fs";
import { logger } from "../core/logger.js";
import { getConfig } from "../config/config.js";
import { statsGenerator } from "./stats-generator.js";
import { DocumentSection, DocumentUpdateResult } from "./types.js";

export class DocumentUpdater {
  // セクション定義
  private sections: Map<string, DocumentSection> = new Map([
    [
      "LEARNING_STATS",
      {
        name: "Learning Statistics",
        startMarker: "<!-- KAIROS:LEARNING_STATS:START -->",
        endMarker: "<!-- KAIROS:LEARNING_STATS:END -->",
        generator: () => statsGenerator.generateLearningStatsMarkdown(),
      },
    ],
    [
      "SYSTEM_STATUS",
      {
        name: "System Status",
        startMarker: "<!-- KAIROS:SYSTEM_STATUS:START -->",
        endMarker: "<!-- KAIROS:SYSTEM_STATUS:END -->",
        generator: () => statsGenerator.generateSystemStatusMarkdown(),
      },
    ],
  ]);

  private lastUpdateTime: Date | null = null;

  /**
   * カスタムセクションを追加
   */
  addSection(id: string, section: DocumentSection): void {
    this.sections.set(id, section);
  }

  /**
   * 更新頻度に基づいて更新が必要かチェック
   */
  shouldUpdate(): boolean {
    const config = getConfig();

    if (!config.docs.enabled) {
      return false;
    }

    if (!this.lastUpdateTime) {
      return true;
    }

    const now = new Date();
    const elapsed = now.getTime() - this.lastUpdateTime.getTime();

    switch (config.docs.updateFrequency) {
      case "every-cycle":
        return true;
      case "daily":
        return elapsed > 24 * 60 * 60 * 1000;
      case "weekly":
        return elapsed > 7 * 24 * 60 * 60 * 1000;
      default:
        return true;
    }
  }

  /**
   * 単一のセクションを置換
   */
  private replaceSectionContent(
    content: string,
    section: DocumentSection
  ): { content: string; updated: boolean } {
    const { startMarker, endMarker, generator } = section;

    const startIndex = content.indexOf(startMarker);
    const endIndex = content.indexOf(endMarker);

    if (startIndex === -1 || endIndex === -1) {
      return { content, updated: false };
    }

    if (startIndex >= endIndex) {
      logger.warn("Invalid marker positions", {
        section: section.name,
        startIndex,
        endIndex,
      });
      return { content, updated: false };
    }

    const newContent =
      typeof generator === "function" ? generator() : generator;

    const before = content.substring(0, startIndex + startMarker.length);
    const after = content.substring(endIndex);

    const updatedContent = `${before}\n${newContent}\n${after}`;

    return { content: updatedContent, updated: true };
  }

  /**
   * 指定されたセクションを更新
   */
  private async updateSections(
    content: string,
    sectionIds: string[]
  ): Promise<{ content: string; updatedSections: string[] }> {
    let currentContent = content;
    const updatedSections: string[] = [];

    for (const sectionId of sectionIds) {
      const section = this.sections.get(sectionId);
      if (!section) {
        logger.warn("Unknown section ID", { sectionId });
        continue;
      }

      const result = this.replaceSectionContent(currentContent, section);
      if (result.updated) {
        currentContent = result.content;
        updatedSections.push(sectionId);
      }
    }

    return { content: currentContent, updatedSections };
  }

  /**
   * 単一ファイルを更新
   */
  async updateDocument(
    path: string,
    sectionIds: string[]
  ): Promise<DocumentUpdateResult> {
    const result: DocumentUpdateResult = {
      path,
      updated: false,
      updatedSections: [],
      errors: [],
    };

    if (!existsSync(path)) {
      result.errors.push(`File not found: ${path}`);
      return result;
    }

    try {
      const content = readFileSync(path, "utf-8");
      const updateResult = await this.updateSections(content, sectionIds);

      if (updateResult.updatedSections.length > 0) {
        writeFileSync(path, updateResult.content);
        result.updated = true;
        result.updatedSections = updateResult.updatedSections;

        logger.info("Document updated", {
          path,
          sections: updateResult.updatedSections,
        });
      }
    } catch (err) {
      const errorMessage = err instanceof Error ? err.message : String(err);
      result.errors.push(errorMessage);
      logger.error("Failed to update document", { path, error: errorMessage });
    }

    return result;
  }

  /**
   * 設定に基づいて全ドキュメントを更新
   */
  async updateAllDocuments(): Promise<DocumentUpdateResult[]> {
    if (!this.shouldUpdate()) {
      logger.debug("Document update skipped due to frequency settings");
      return [];
    }

    const config = getConfig();
    const results: DocumentUpdateResult[] = [];

    for (const target of config.docs.targets) {
      const result = await this.updateDocument(target.path, target.sections);
      results.push(result);
    }

    this.lastUpdateTime = new Date();
    return results;
  }

  /**
   * 利用可能なセクションIDを取得
   */
  getAvailableSections(): string[] {
    return Array.from(this.sections.keys());
  }

  /**
   * ステータスを取得
   */
  getStatus(): {
    enabled: boolean;
    lastUpdate: string | null;
    updateFrequency: string;
    availableSections: string[];
    targetCount: number;
  } {
    const config = getConfig();
    return {
      enabled: config.docs.enabled,
      lastUpdate: this.lastUpdateTime?.toISOString() || null,
      updateFrequency: config.docs.updateFrequency,
      availableSections: this.getAvailableSections(),
      targetCount: config.docs.targets.length,
    };
  }
}

export const documentUpdater = new DocumentUpdater();
