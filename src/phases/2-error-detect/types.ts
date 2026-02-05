export interface ErrorEntry {
  timestamp: Date;
  level: "error" | "warn";
  message: string;
  source: string;
  stack?: string;
}

export interface DetectionResult {
  errors: ErrorEntry[];
  warnings: ErrorEntry[];
  totalScanned: number;
}
