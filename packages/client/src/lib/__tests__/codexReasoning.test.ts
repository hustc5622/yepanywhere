import type { ModelInfo } from "@yep-anywhere/shared";
import { describe, expect, it } from "vitest";
import {
  getModelReasoningEfforts,
  getOpenCodeReasoningPickerEfforts,
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

  it("uses the variants advertised for the selected OpenCode protocol", () => {
    const glm: ModelInfo = {
      id: "glm-5.2",
      name: "GLM-5.2",
      supportedReasoningEfforts: [
        { reasoningEffort: "high" },
        { reasoningEffort: "max" },
      ],
      supportedReasoningEffortsByProtocol: {
        "openai-compatible": [
          { reasoningEffort: "high" },
          { reasoningEffort: "max" },
        ],
        anthropic: [{ reasoningEffort: "max" }],
      },
    };

    expect(
      getModelReasoningEfforts(glm, "openai-compatible").map(
        (option) => option.reasoningEffort,
      ),
    ).toEqual(["high", "max"]);
    expect(
      getModelReasoningEfforts(glm, "anthropic").map(
        (option) => option.reasoningEffort,
      ),
    ).toEqual(["max"]);

    const openAiOnly: ModelInfo = {
      ...glm,
      supportedReasoningEffortsByProtocol: {
        "openai-compatible": [{ reasoningEffort: "max" }],
      },
    };
    expect(getModelReasoningEfforts(openAiOnly, "anthropic")).toEqual([]);
  });

  it("keeps the OpenCode picker independent from model metadata", () => {
    expect(
      getOpenCodeReasoningPickerEfforts().map(
        (option) => option.reasoningEffort,
      ),
    ).toEqual(["low", "medium", "high", "xhigh", "max"]);
    expect(getModelReasoningEfforts(undefined)).toEqual([]);
  });
});
