import { describe, expect, it } from "vitest";
import { getNewSessionProviderAccent } from "../NewSessionForm";

describe("New session form", () => {
  it.each([
    ["claude", "var(--provider-claude)"],
    ["claude-ollama", "var(--provider-claude)"],
    ["codex", "var(--provider-codex)"],
    ["codex-oss", "var(--provider-codex)"],
    ["gemini", "var(--provider-gemini)"],
    ["gemini-acp", "var(--provider-gemini)"],
    ["pi", "var(--provider-pi)"],
    ["kimi", "var(--provider-kimi)"],
    ["zcode", "var(--provider-zcode)"],
  ] as const)("uses the %s provider accent", (provider, expected) => {
    expect(getNewSessionProviderAccent(provider)).toBe(expected);
  });

  it("falls back to the Yep accent before a provider is selected", () => {
    expect(getNewSessionProviderAccent(null)).toBe("var(--app-yep-green)");
  });
});
