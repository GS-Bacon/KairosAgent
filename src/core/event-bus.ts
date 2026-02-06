import { logger } from "./logger.js";

type EventHandler<T = unknown> = (data: T) => void | Promise<void>;

interface EventSubscription {
  unsubscribe: () => void;
}

export interface CriticalAlert {
  alertType: "ai_providers_broken" | "system_failure";
  message: string;
  timestamp: Date;
  affectedProviders?: string[];
  context?: Record<string, unknown>;
}

export type KairosEvent =
  | { type: "cycle_started"; timestamp: Date }
  | { type: "cycle_completed"; timestamp: Date; duration: number }
  | { type: "phase_started"; phase: string; timestamp: Date }
  | { type: "phase_completed"; phase: string; success: boolean; timestamp: Date }
  | { type: "issue_detected"; issue: { type: string; description: string } }
  | { type: "modification"; file: string; changeType: string; description: string }
  | { type: "rollback"; reason: string; snapshotId: string }
  | { type: "error"; error: string; context?: Record<string, unknown> }
  | { type: "trouble_captured"; trouble: { id: string; category: string; severity: string; message: string; phase: string }; timestamp: Date }
  | { type: "critical_alert"; alert: CriticalAlert }
  | { type: "provider_health_changed"; provider: string; oldStatus: string; newStatus: string; timestamp: Date }
  | { type: "health_repair_attempted"; checkName: string; success: boolean; details: string; timestamp: Date };

export class EventBus {
  private handlers: Map<string, Set<EventHandler>> = new Map();
  private allHandlers: Set<EventHandler<KairosEvent>> = new Set();

  on<T extends KairosEvent["type"]>(
    eventType: T,
    handler: EventHandler<Extract<KairosEvent, { type: T }>>
  ): EventSubscription {
    if (!this.handlers.has(eventType)) {
      this.handlers.set(eventType, new Set());
    }
    this.handlers.get(eventType)!.add(handler as EventHandler);

    return {
      unsubscribe: () => {
        this.handlers.get(eventType)?.delete(handler as EventHandler);
      },
    };
  }

  onAll(handler: EventHandler<KairosEvent>): EventSubscription {
    this.allHandlers.add(handler);
    return {
      unsubscribe: () => {
        this.allHandlers.delete(handler);
      },
    };
  }

  async emit(event: KairosEvent): Promise<void> {
    const typeHandlers = this.handlers.get(event.type);
    if (typeHandlers) {
      for (const handler of typeHandlers) {
        try {
          await handler(event);
        } catch (err) {
          logger.error(`Event handler error for ${event.type}`, { error: err instanceof Error ? err.message : String(err) });
        }
      }
    }

    for (const handler of this.allHandlers) {
      try {
        await handler(event);
      } catch (err) {
        logger.error("Global event handler error", { error: err instanceof Error ? err.message : String(err) });
      }
    }
  }

  clear(): void {
    this.handlers.clear();
    this.allHandlers.clear();
  }
}

export const eventBus = new EventBus();
