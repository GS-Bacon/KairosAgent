import { existsSync, readFileSync, readdirSync, statSync } from "fs";
import { join, relative } from "path";
import { SearchQuery, SearchFinding, SearchAnalysis } from "./types.js";
import { logger } from "../../core/logger.js";

export class CodeSearcher {
  private srcDir: string;

  constructor(srcDir: string = "./src") {
    this.srcDir = srcDir;
  }

  async search(query: SearchQuery): Promise<SearchAnalysis> {
    const findings: SearchFinding[] = [];
    const relatedFiles: Set<string> = new Set();

    const files = this.collectFiles(this.srcDir);
    const searchTerms = this.extractSearchTerms(query.target);

    for (const file of files) {
      try {
        const content = readFileSync(file, "utf-8");
        const relativePath = relative(this.srcDir, file);
        const lines = content.split("\n");

        let fileRelevance = 0;
        const matchedLines: Array<{ line: number; content: string; relevance: number }> = [];

        for (let i = 0; i < lines.length; i++) {
          const line = lines[i];
          const lineRelevance = this.calculateRelevance(line, searchTerms);

          if (lineRelevance > 0) {
            fileRelevance += lineRelevance;
            matchedLines.push({
              line: i + 1,
              content: line.trim(),
              relevance: lineRelevance,
            });
          }
        }

        if (fileRelevance > 0) {
          relatedFiles.add(relativePath);

          // Add top matches
          for (const match of matchedLines.slice(0, 5)) {
            findings.push({
              file: relativePath,
              line: match.line,
              content: match.content,
              relevance: match.relevance,
            });
          }
        }
      } catch (err) {
        logger.warn(`Failed to search file: ${file}`);
      }
    }

    // Sort by relevance
    findings.sort((a, b) => b.relevance - a.relevance);

    return {
      query,
      findings: findings.slice(0, 20),
      relatedFiles: Array.from(relatedFiles),
    };
  }

  async findDependencies(file: string): Promise<string[]> {
    const deps: Set<string> = new Set();
    const fullPath = join(this.srcDir, file);

    if (!existsSync(fullPath)) return [];

    try {
      const content = readFileSync(fullPath, "utf-8");
      const importMatches = content.matchAll(/import\s+.*\s+from\s+['"](.+?)['"]/g);

      for (const match of importMatches) {
        const importPath = match[1];
        if (importPath.startsWith(".")) {
          deps.add(importPath);
        }
      }
    } catch {
      logger.warn(`Failed to find dependencies for: ${file}`);
    }

    return Array.from(deps);
  }

  async findUsages(identifier: string): Promise<SearchFinding[]> {
    const query: SearchQuery = {
      target: identifier,
      type: "dependency",
    };
    const result = await this.search(query);
    return result.findings;
  }

  private collectFiles(dir: string): string[] {
    const files: string[] = [];
    if (!existsSync(dir)) return files;

    const entries = readdirSync(dir);
    for (const entry of entries) {
      const fullPath = join(dir, entry);
      const stat = statSync(fullPath);

      if (stat.isDirectory()) {
        if (!["node_modules", ".git", "dist"].includes(entry)) {
          files.push(...this.collectFiles(fullPath));
        }
      } else if (entry.endsWith(".ts") || entry.endsWith(".js")) {
        files.push(fullPath);
      }
    }

    return files;
  }

  private extractSearchTerms(target: string): string[] {
    const terms = target
      .split(/[\s,;:.]+/)
      .filter((t) => t.length > 2)
      .map((t) => t.toLowerCase());

    return [...new Set(terms)];
  }

  private calculateRelevance(line: string, terms: string[]): number {
    const lower = line.toLowerCase();
    let relevance = 0;

    for (const term of terms) {
      if (lower.includes(term)) {
        relevance += 1;
        if (lower.match(new RegExp(`\\b${term}\\b`))) {
          relevance += 0.5;
        }
      }
    }

    return relevance;
  }
}
