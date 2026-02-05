import { describe, it, expect, vi, beforeEach } from "vitest";

describe("Logger", () => {
  it("should be importable", async () => {
    const { Logger } = await import("../src/core/logger.js");
    expect(Logger).toBeDefined();
  });
});

describe("EventBus", () => {
  it("should be importable", async () => {
    const { EventBus } = await import("../src/core/event-bus.js");
    expect(EventBus).toBeDefined();
  });

  it("should emit and receive events", async () => {
    const { EventBus } = await import("../src/core/event-bus.js");
    const bus = new EventBus();
    const handler = vi.fn();

    bus.on("cycle_started", handler);
    await bus.emit({ type: "cycle_started", timestamp: new Date() });

    expect(handler).toHaveBeenCalled();
  });
});

describe("Scheduler", () => {
  it("should be importable", async () => {
    const { Scheduler } = await import("../src/core/scheduler.js");
    expect(Scheduler).toBeDefined();
  });

  it("should register tasks", async () => {
    const { Scheduler } = await import("../src/core/scheduler.js");
    const scheduler = new Scheduler();

    scheduler.register("test", "Test Task", 1000, async () => {});
    const status = scheduler.getStatus();

    expect(status.tasks).toHaveLength(1);
    expect(status.tasks[0].name).toBe("Test Task");
  });
});
