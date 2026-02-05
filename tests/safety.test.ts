import { describe, it, expect } from "vitest";

describe("Guard", () => {
  it("should be importable", async () => {
    const { Guard } = await import("../src/safety/guard.js");
    expect(Guard).toBeDefined();
  });

  it("should protect safety files", async () => {
    const { Guard } = await import("../src/safety/guard.js");
    const guard = new Guard();

    expect(guard.isFileProtected("src/safety/guard.ts")).toBe(true);
    expect(guard.isFileProtected("src/core/logger.ts")).toBe(true);
    expect(guard.isFileProtected("src/phases/1-health-check/index.ts")).toBe(false);
  });

  it("should allow valid extensions", async () => {
    const { Guard } = await import("../src/safety/guard.js");
    const guard = new Guard();

    expect(guard.isExtensionAllowed("file.ts")).toBe(true);
    expect(guard.isExtensionAllowed("file.js")).toBe(true);
    expect(guard.isExtensionAllowed("file.exe")).toBe(false);
  });

  it("should validate changes", async () => {
    const { Guard } = await import("../src/safety/guard.js");
    const guard = new Guard();

    const valid = guard.validateChange({
      files: ["src/phases/1-health-check/index.ts"],
    });
    expect(valid.allowed).toBe(true);

    const invalid = guard.validateChange({
      files: ["src/safety/guard.ts"],
    });
    expect(invalid.allowed).toBe(false);
  });

  it("should detect dangerous code", async () => {
    const { Guard } = await import("../src/safety/guard.js");
    const guard = new Guard();

    const safe = guard.validateCodeContent("const x = 1;");
    expect(safe.safe).toBe(true);

    const dangerous = guard.validateCodeContent("eval(userInput)");
    expect(dangerous.safe).toBe(false);
    expect(dangerous.warnings).toContain("Potentially dangerous: eval()");
  });
});

describe("Snapshot Manager", () => {
  it("should be importable", async () => {
    const { SnapshotManager } = await import("../src/safety/snapshot.js");
    expect(SnapshotManager).toBeDefined();
  });
});

describe("Rollback Manager", () => {
  it("should be importable", async () => {
    const { RollbackManager } = await import("../src/safety/rollback.js");
    expect(RollbackManager).toBeDefined();
  });
});
