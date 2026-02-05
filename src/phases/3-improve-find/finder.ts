import { existsSync, readFileSync, readdirSync, statSync } from "fs";
import { join, relative } from "path";
import { CodeMarker, QualityIssue, ImprovementFindResult } from "./types.js";
import { logger } from "../../core/logger.js";

export class ImprovementFinder {
  private srcDir: string;
  private markerPatterns: RegExp[];

  constructor(srcDir: string = "./src") {
    this.srcDir = srcDir;
    this.markerPatterns = [
      /\/\/\s*(TODO|FIXME|HACK|NOTE|OPTIMIZE)[\s:]+(.+)/gi,
      /\/\*\s*(TODO|FIXME|HACK|NOTE|OPTIMIZE)[\s:]+(.+?)\*\//gi,
    ];
  }

  async find(): Promise<ImprovementFindResult> {
    const markers: CodeMarker[] = [];
    const qualityIssues: QualityIssue[] = [];

    if (!existsSync(this.srcDir)) {
      return { markers, qualityIssues };
    }

    const files = this.collectFiles(this.srcDir);

    for (const file of files) {
      try {
        const content = readFileSync(file, "utf-8");
        const relativePath = relative(this.srcDir, file);

        const fileMarkers = this.findMarkers(content, relativePath);
        markers.push(...fileMarkers);

        const fileIssues = this.analyzeQuality(content, relativePath);
        qualityIssues.push(...fileIssues);
      } catch (err) {
        logger.warn(`Failed to analyze file: ${file}`);
      }
    }

    return { markers, qualityIssues };
  }

  private collectFiles(dir: string): string[] {
    const files: string[] = [];
    const entries = readdirSync(dir);

    for (const entry of entries) {
      const fullPath = join(dir, entry);
      const stat = statSync(fullPath);

      if (stat.isDirectory()) {
        if (entry !== "node_modules" && entry !== ".git" && entry !== "dist") {
          files.push(...this.collectFiles(fullPath));
        }
      } else if (entry.endsWith(".ts") || entry.endsWith(".js")) {
        files.push(fullPath);
      }
    }

    return files;
  }

  private findMarkers(content: string, file: string): CodeMarker[] {
    const markers: CodeMarker[] = [];
    const lines = content.split("\n");

    for (let i = 0; i < lines.length; i++) {
      const line = lines[i];
      for (const pattern of this.markerPatterns) {
        pattern.lastIndex = 0;
        const match = pattern.exec(line);
        if (match) {
          markers.push({
            type: match[1].toLowerCase() as CodeMarker["type"],
            text: match[2].trim(),
            file,
            line: i + 1,
          });
        }
      }
    }

    return markers;
  }

  private analyzeQuality(content: string, file: string): QualityIssue[] {
    const issues: QualityIssue[] = [];
    const lines = content.split("\n");

    // Check for very long functions
    let braceDepth = 0;
    let functionStart = -1;
    for (let i = 0; i < lines.length; i++) {
      const line = lines[i];
      if (line.match(/^\s*(async\s+)?function\s+|^\s*(async\s+)?\w+\s*\([^)]*\)\s*[:{]/)) {
        functionStart = i;
      }
      braceDepth += (line.match(/{/g) || []).length;
      braceDepth -= (line.match(/}/g) || []).length;

      if (functionStart >= 0 && braceDepth === 0 && i - functionStart > 50) {
        issues.push({
          type: "complexity",
          description: `Long function (${i - functionStart} lines) starting at line ${functionStart + 1}`,
          file,
          severity: i - functionStart > 100 ? "high" : "medium",
        });
        functionStart = -1;
      }
    }

    // Check for very long lines
    for (let i = 0; i < lines.length; i++) {
      if (lines[i].length > 120) {
        issues.push({
          type: "structure",
          description: `Line ${i + 1} is too long (${lines[i].length} chars)`,
          file,
          severity: "low",
        });
      }
    }

    return issues;
  }
}
