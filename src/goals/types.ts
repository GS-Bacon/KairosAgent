export type GoalType = "permanent" | "one-time";

export interface GoalMetric {
  name: string;
  target: number;
  current: number;
  unit?: string;
}

export interface Goal {
  id: string;
  type: GoalType;
  title: string;
  description: string;
  metrics: GoalMetric[];
  createdAt: string;
  completedAt?: string;
  active: boolean;
}

export interface GoalProgress {
  goalId: string;
  cycleId: string;
  timestamp: string;
  metricUpdates: Array<{
    name: string;
    previousValue: number;
    newValue: number;
  }>;
  notes?: string;
}

export interface GoalData {
  goals: Goal[];
  progress: GoalProgress[];
}
