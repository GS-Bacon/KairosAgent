type EventHandler<T = unknown> = (data: T) => void | Promise<void>;

interface EventSubscription {
  unsubscribe: () => void;
}

export type MoltBotEvent =
  | { type: "cycle_started"; timestamp: Date }
  | { type: "cycle_completed"; timestamp: Date; duration: number }
  | { type: "phase_started"; phase: string; timestamp: Date }
  | { type: "phase_completed"; phase: string; success: boolean; timestamp: Date }
  | { type: "issue_detected"; issue: { type: string; description: string } }
  | { type: "modification"; file: string; changeType: string; description: string }
  | { type: "rollback"; reason: string; snapshotId: string }
  | { type: "error"; error: string; context?: Record<string, unknown> };

export class EventBus {
  private handlers: Map<string, Set<EventHandler>> = new Map();
  private allHandlers: Set<EventHandler<MoltBotEvent>> = new Set();

  on<T extends MoltBotEvent["type"]>(
    eventType: T,
    handler: EventHandler<Extract<MoltBotEvent, { type: T }>>
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

  onAll(handler: EventHandler<MoltBotEvent>): EventSubscription {
    this.allHandlers.add(handler);
    return {
      unsubscribe: () => {
        this.allHandlers.delete(handler);
      },
    };
  }

  async emit(event: MoltBotEvent): Promise<void> {
    const typeHandlers = this.handlers.get(event.type);
    if (typeHandlers) {
      for (const handler of typeHandlers) {
        try {
          await handler(event);
        } catch (err) {
          console.error(`Event handler error for ${event.type}:`, err);
        }
      }
    }

    for (const handler of this.allHandlers) {
      try {
        await handler(event);
      } catch (err) {
        console.error(`Global event handler error:`, err);
      }
    }
  }

  clear(): void {
    this.handlers.clear();
    this.allHandlers.clear();
  }
}

export const eventBus = new EventBus();
