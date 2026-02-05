export interface HealthStatus {
  overall: "healthy" | "degraded" | "unhealthy";
  checks: HealthCheck[];
  timestamp: Date;
}

export interface HealthCheck {
  name: string;
  status: "pass" | "fail" | "warn";
  message?: string;
  duration?: number;
  repairAttempted?: boolean;
  repairSuccess?: boolean;
}
