import type { ModelInfo } from "@yep-anywhere/shared";
import { describe, expect, it } from "vitest";
import {
  getModelReasoningEfforts,
  resolveModelReasoningEffort,
} from "../codexReasoning";

const sol: ModelInfo = {
  id: "gpt-5.6-sol",
  name: "GPT-5.6-Sol",
  defaultReasoningEffort: "low",
  supportedReasoningEfforts: [
    { reasoningEffort: "low" },
    { reasoningEffort: "medium" },
    { reasoningEffort: "high" },
    { reasoningEffort: "xhigh" },
    { reasoningEffort: "max" },
    { reasoningEffort: "ultra" },
  ],
};

const luna: ModelInfo = {
  id: "gpt-5.6-luna",
  name: "GPT-5.6-Luna",
  defaultReasoningEffort: "medium",
  supportedReasoningEfforts: sol.supportedReasoningEfforts?.filter(
    (option) => option.reasoningEffort !== "ultra",
  ),
};

describe("Codex model reasoning efforts", () => {
  it("preserves the app-server order including max and ultra", () => {
    expect(
      getModelReasoningEfforts(sol).map((option) => option.reasoningEffort),
    ).toEqual(["low", "medium", "high", "xhigh", "max", "ultra"]);
  });

  it("falls back to the next model's advertised default", () => {
    expect(resolveModelReasoningEffort(luna, "ultra")).toBe("medium");
  });

  it("keeps a preferred effort when the target model supports it", () => {
    expect(resolveModelReasoningEffort(luna, "xhigh")).toBe("xhigh");
  });
});
