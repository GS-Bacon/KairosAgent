export interface SearchQuery {
  target: string;
  type: "error" | "improvement" | "dependency";
  context?: string;
}

export interface SearchFinding {
  file: string;
  line?: number;
  content: string;
  relevance: number;
}

export interface SearchAnalysis {
  query: SearchQuery;
  findings: SearchFinding[];
  relatedFiles: string[];
  summary?: string;
}
