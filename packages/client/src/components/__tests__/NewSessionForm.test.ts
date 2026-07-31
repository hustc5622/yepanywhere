import { describe, expect, it } from "vitest";
import {
  getNewSessionProviderAccent,
  getOpenCodeModelLimits,
  parseOpenCodeAdvancedInput,
} from "../NewSessionForm";

describe("New session form", () => {
  it.each([
    ["claude", "var(--provider-claude)"],
    ["claude-ollama", "var(--provider-claude)"],
    ["codex", "var(--provider-codex)"],
    ["codex-oss", "var(--provider-codex)"],
    ["gemini", "var(--provider-gemini)"],
    ["gemini-acp", "var(--provider-gemini)"],
    ["opencode", "var(--provider-opencode)"],
    ["kimi", "var(--provider-kimi)"],
  ] as const)("uses the %s provider accent", (provider, expected) => {
    expect(getNewSessionProviderAccent(provider)).toBe(expected);
  });

  it("falls back to the Yep accent before a provider is selected", () => {
    expect(getNewSessionProviderAccent(null)).toBe("var(--app-yep-green)");
  });

  it("parses context and output values expressed in K tokens", () => {
    expect(getOpenCodeModelLimits("1000", "32")).toEqual({
      limits: { context: 1_000_000, output: 32_000 },
    });
  });

  it("requires both model limits when either one is set", () => {
    expect(getOpenCodeModelLimits("1000", "")).toEqual({
      error: "incomplete",
    });
  });

  it("accepts only JSON objects for advanced provider/model patches", () => {
    expect(
      parseOpenCodeAdvancedInput(
        '{"options":{"headers":{"X-Sub-Module":"coding"}}}',
      ),
    ).toEqual({
      value: {
        options: { headers: { "X-Sub-Module": "coding" } },
      },
    });
    expect(parseOpenCodeAdvancedInput("[]")).toEqual({ error: "invalid" });
    expect(parseOpenCodeAdvancedInput("{")).toEqual({ error: "invalid" });
  });
});
