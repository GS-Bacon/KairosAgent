import { Phase, PhaseResult, CycleContext } from "../types.js";
import { CodeSearcher } from "./searcher.js";
import { SearchQuery, SearchAnalysis } from "./types.js";
import { logger } from "../../core/logger.js";

export class SearchPhase implements Phase {
  name = "search";
  private searcher: CodeSearcher;

  constructor() {
    this.searcher = new CodeSearcher();
  }

  async execute(context: CycleContext): Promise<PhaseResult> {
    if (context.issues.length === 0 && context.improvements.length === 0) {
      return {
        success: true,
        shouldStop: true,
        message: "No issues or improvements to search for",
      };
    }

    logger.debug("Searching for related code");

    // Prioritize issues over improvements
    const target = context.issues[0] || context.improvements[0];

    const query: SearchQuery = {
      target: target.message || (target as any).description,
      type: context.issues.length > 0 ? "error" : "improvement",
      context: target.file,
    };

    const analysis = await this.searcher.search(query);

    // If we have a specific file, also get its dependencies
    if (target.file) {
      const deps = await this.searcher.findDependencies(target.file);
      for (const dep of deps) {
        if (!analysis.relatedFiles.includes(dep)) {
          analysis.relatedFiles.push(dep);
        }
      }
    }

    context.searchResults = {
      query: query.target,
      findings: analysis.findings.map((f) => ({
        file: f.file,
        content: f.content,
        relevance: f.relevance,
      })),
      analysis: analysis.summary,
    };

    logger.info("Search completed", {
      findings: analysis.findings.length,
      relatedFiles: analysis.relatedFiles.length,
    });

    return {
      success: true,
      shouldStop: false,
      message: `Found ${analysis.findings.length} related code sections`,
      data: analysis,
    };
  }
}

export { CodeSearcher } from "./searcher.js";
export * from "./types.js";
