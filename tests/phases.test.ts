import { describe, it, expect } from "vitest";
import { createCycleContext } from "../src/phases/types.js";

describe("Phase Types", () => {
  it("should create cycle context", () => {
    const context = createCycleContext();

    expect(context.cycleId).toBeDefined();
    expect(context.startTime).toBeInstanceOf(Date);
    expect(context.issues).toEqual([]);
    expect(context.improvements).toEqual([]);
  });
});

describe("Health Check Phase", () => {
  it("should be importable", async () => {
    const { HealthCheckPhase } = await import("../src/phases/1-health-check/index.js");
    expect(HealthCheckPhase).toBeDefined();
  });

  it("should execute health check", async () => {
    const { HealthCheckPhase } = await import("../src/phases/1-health-check/index.js");
    const phase = new HealthCheckPhase();
    const context = createCycleContext();

    const result = await phase.execute(context);

    expect(result.success).toBe(true);
    expect(result.data).toBeDefined();
  });
});

describe("Error Detect Phase", () => {
  it("should be importable", async () => {
    const { ErrorDetectPhase } = await import("../src/phases/2-error-detect/index.js");
    expect(ErrorDetectPhase).toBeDefined();
  });
});

describe("Improve Find Phase", () => {
  it("should be importable", async () => {
    const { ImproveFindPhase } = await import("../src/phases/3-improve-find/index.js");
    expect(ImproveFindPhase).toBeDefined();
  });
});
