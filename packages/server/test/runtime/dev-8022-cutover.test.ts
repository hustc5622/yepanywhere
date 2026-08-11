import { describe, expect, it } from "vitest";
import {
  classifyDevCutover,
  classifyMaintenanceOwner,
  findDuplicateDevPort,
  formatDevCutoverWait,
  hasUnknownViteOwner,
} from "../../../../scripts/dev-8022-cutover.js";

describe("dev 8022 cutover", () => {
  it("waits while an embedded runtime owns active work", () => {
    const activity = {
      activeWorkers: 5,
      queueLength: 0,
      hasActiveWork: true,
      runtimeMode: "embedded",
    };

    expect(classifyDevCutover(activity)).toBe("wait");
    expect(formatDevCutoverWait(activity)).toBe(
      "YEP_DEV_8022_WAITING_FOR_IDLE workers=5 queue=0",
    );
  });

  it("allows replacing an idle embedded runtime", () => {
    expect(
      classifyDevCutover({
        activeWorkers: 5,
        queueLength: 0,
        hasActiveWork: false,
        runtimeMode: "embedded",
      }),
    ).toBe("safe");
  });

  it("allows replacing the shell while an external runtime is active", () => {
    expect(
      classifyDevCutover({
        activeWorkers: 2,
        queueLength: 1,
        hasActiveWork: true,
        runtimeMode: "external",
      }),
    ).toBe("safe");
  });

  it("preserves the compatibility behavior for an unavailable status route", () => {
    expect(classifyDevCutover(null)).toBe("unknown");
  });

  it("rejects overlapping configured ports", () => {
    expect(
      findDuplicateDevPort([
        ["server", 8022],
        ["maintenance", 8023],
        ["vite", 8023],
      ]),
    ).toEqual({ port: 8023, names: ["maintenance", "vite"] });
  });

  it("only trusts the maintenance listener for the target main server", () => {
    expect(
      classifyMaintenanceOwner({
        listenPids: ["123"],
        status: { pid: 123, mainServerPort: 8022 },
        mainServerPort: 8022,
      }),
    ).toBe("owned");
    expect(
      classifyMaintenanceOwner({
        listenPids: ["123"],
        status: { pid: 123, mainServerPort: 3400 },
        mainServerPort: 8022,
      }),
    ).toBe("conflict");
  });

  it("detects unrelated Vite port owners", () => {
    expect(hasUnknownViteOwner(["123", "456"], ["123"])).toBe(true);
    expect(hasUnknownViteOwner(["123"], ["123"])).toBe(false);
  });
});
