import { describe, expect, it } from "vitest";
import {
  classifyDevCutover,
  formatDevCutoverWait,
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
});
