export interface CodeMarker {
  type: "todo" | "fixme" | "hack" | "note" | "optimize";
  text: string;
  file: string;
  line: number;
}

export interface QualityIssue {
  type: "complexity" | "duplication" | "naming" | "structure";
  description: string;
  file: string;
  severity: "low" | "medium" | "high";
}

export interface ImprovementFindResult {
  markers: CodeMarker[];
  qualityIssues: QualityIssue[];
}
