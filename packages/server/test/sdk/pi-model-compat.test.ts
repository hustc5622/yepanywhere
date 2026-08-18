import { describe, expect, it } from "vitest";
import { piAnthropicModelTraits } from "../../src/sdk/providers/pi-model-compat.js";

describe("piAnthropicModelTraits", () => {
  it("forces the adaptive thinking payload for current Claude releases", () => {
    for (const id of [
      "claude-opus-4-6",
      "claude-opus-4-7",
      "claude-opus-4-8",
      "claude-opus-4-8-fast",
      "claude-opus-5",
      "claude-sonnet-4-6",
      "claude-sonnet-5",
      "claude-fable-5",
      "claude-opus-4.8",
    ]) {
      expect(piAnthropicModelTraits(id).compat?.forceAdaptiveThinking, id).toBe(
        true,
      );
    }
  });

  it("leaves budget-based thinking alone for older or non-Claude models", () => {
    for (const id of [
      "claude-opus-4-5",
      "claude-sonnet-4-5-20250929",
      "claude-haiku-4-5",
      "glm-5.2",
      "gpt-5.6-sol",
    ]) {
      expect(piAnthropicModelTraits(id), id).toEqual({});
    }
  });

  it("advertises xhigh only where Anthropic supports it", () => {
    expect(piAnthropicModelTraits("claude-opus-4-6").thinkingLevelMap).toEqual({
      max: "max",
    });
    expect(
      piAnthropicModelTraits("claude-sonnet-4-6").thinkingLevelMap,
    ).toEqual({ max: "max" });
    expect(piAnthropicModelTraits("claude-opus-5").thinkingLevelMap).toEqual({
      max: "max",
      xhigh: "xhigh",
    });
    expect(piAnthropicModelTraits("claude-sonnet-5").thinkingLevelMap).toEqual({
      max: "max",
      xhigh: "xhigh",
    });
  });

  it("marks Fable 5 as unable to disable thinking", () => {
    // Upstream expresses this as `off: null`; without it Pi would send
    // `thinking: { type: "disabled" }` to a model that rejects it.
    expect(piAnthropicModelTraits("claude-fable-5").thinkingLevelMap).toEqual({
      max: "max",
      xhigh: "xhigh",
      off: null,
    });
  });

  it("drops temperature for the models that reject it", () => {
    expect(piAnthropicModelTraits("claude-opus-5").compat).toEqual({
      forceAdaptiveThinking: true,
      supportsTemperature: false,
    });
    expect(piAnthropicModelTraits("claude-opus-4-8").compat).toEqual({
      forceAdaptiveThinking: true,
      supportsTemperature: false,
    });
    // Opus 4.6 and the Sonnet line still accept temperature.
    expect(piAnthropicModelTraits("claude-opus-4-6").compat).toEqual({
      forceAdaptiveThinking: true,
    });
    expect(piAnthropicModelTraits("claude-sonnet-5").compat).toEqual({
      forceAdaptiveThinking: true,
    });
  });
});
